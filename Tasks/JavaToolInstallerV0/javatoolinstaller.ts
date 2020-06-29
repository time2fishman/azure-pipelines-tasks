import fs = require('fs');
import os = require('os');
import path = require('path');
import taskLib = require('azure-pipelines-task-lib/task');
import toolLib = require('azure-pipelines-tool-lib/tool');
import { ToolRunner } from 'azure-pipelines-task-lib/toolrunner';
import uuidV4 = require('uuid/v4');

import { AzureStorageArtifactDownloader } from './AzureStorageArtifacts/AzureStorageArtifactDownloader';
import { JavaFilesExtractor, BIN_FOLDER } from './FileExtractor/JavaFilesExtractor';

const supportedFileEndings = ['.tar', '.tar.gz', '.zip', '.7z', '.dmg', '.pkg'];
const VOLUMES_FOLDER = '/Volumes';
const JDK_FOLDER = '/Library/Java/JavaVirtualMachines';
const JDK_HOME_FOLDER = 'Contents/Home';
taskLib.setResourcePath(path.join(__dirname, 'task.json'));

async function run() {
    try {
        let versionSpec = taskLib.getInput('versionSpec', true);
        await getJava(versionSpec);
        taskLib.setResult(taskLib.TaskResult.Succeeded, taskLib.loc('SucceedMsg'));
    } catch (error) {
        taskLib.error(error.message);
        taskLib.setResult(taskLib.TaskResult.Failed, error.message);
    }
}

async function getJava(versionSpec: string) {
    const preInstalled: boolean = ('PreInstalled' === taskLib.getInput('jdkSourceOption', true));
    const fromAzure: boolean = ('AzureStorage' == taskLib.getInput('jdkSourceOption', true));
    const extractLocation: string = taskLib.getPathInput('jdkDestinationDirectory', true);
    const cleanDestinationDirectory: boolean = taskLib.getBoolInput('cleanDestinationDirectory', false);
    let compressedFileExtension: string;
    let jdkDirectory: string;
    const extendedJavaHome: string = `JAVA_HOME_${versionSpec}_${taskLib.getInput('jdkArchitectureOption', true)}`;

    toolLib.debug('Trying to get tool from local cache first');
    const localVersions: string[] = toolLib.findLocalToolVersions('Java');
    const version: string = toolLib.evaluateVersions(localVersions, versionSpec);

     // Clean the destination folder before downloading and extracting?
     if (cleanDestinationDirectory && taskLib.exist(extractLocation) && taskLib.stats(extractLocation).isDirectory) {
        console.log(taskLib.loc('CleanDestDir', extractLocation));

        // delete the contents of the destination directory but leave the directory in place
        fs.readdirSync(extractLocation)
        .forEach((item: string) => {
            const itemPath = path.join(extractLocation, item);
            taskLib.rmRF(itemPath);
        });
    }

    if (version) { //This version of Java JDK is already in the cache. Use it instead of downloading again.
        console.log(taskLib.loc('Info_ResolvedToolFromCache', version));
    } else if (preInstalled) {
        const preInstalledJavaDirectory: string | undefined = taskLib.getVariable(extendedJavaHome);
        if (preInstalledJavaDirectory === undefined) {
            throw new Error(taskLib.loc('JavaNotPreinstalled', versionSpec));
        }
        console.log(taskLib.loc('UsePreinstalledJava', preInstalledJavaDirectory));
        jdkDirectory = preInstalledJavaDirectory;
    } else if (fromAzure) { //Download JDK from an Azure blob storage location and extract.
        console.log(taskLib.loc('RetrievingJdkFromAzure'));
        const fileNameAndPath: string = taskLib.getInput('azureCommonVirtualFile', false);

        const azureDownloader = new AzureStorageArtifactDownloader(taskLib.getInput('azureResourceManagerEndpoint', true),
            taskLib.getInput('azureStorageAccountName', true), taskLib.getInput('azureContainerName', true), "");
        await azureDownloader.downloadArtifacts(extractLocation, '*' + fileNameAndPath);
        await sleepFor(250); //Wait for the file to be released before extracting it.

        compressedFileExtension = getSupportedFileEnding(fileNameAndPath);
        const extractSource = buildFilePath(extractLocation, compressedFileExtension, fileNameAndPath);
        jdkDirectory = await installJDK(extractSource, compressedFileExtension, extractLocation);
    } else { //JDK is in a local directory. Extract to specified target directory.
        console.log(taskLib.loc('RetrievingJdkFromLocalPath'));
        const jdkFile: string = taskLib.getInput('jdkFile', true);
        compressedFileExtension = getSupportedFileEnding(jdkFile);
        jdkDirectory = await installJDK(jdkFile, compressedFileExtension, extractLocation);
    }

    console.log(taskLib.loc('SetJavaHome', jdkDirectory));
    console.log(taskLib.loc('SetExtendedJavaHome', extendedJavaHome, jdkDirectory));
    taskLib.setVariable('JAVA_HOME', jdkDirectory);
    taskLib.setVariable(extendedJavaHome, jdkDirectory);
    toolLib.prependPath(path.join(jdkDirectory, BIN_FOLDER));
}

function sleepFor(sleepDurationInMillisecondsSeconds): Promise<any> {
    return new Promise((resolve, reeject) => {
        setTimeout(resolve, sleepDurationInMillisecondsSeconds);
    });
}

function buildFilePath(localPathRoot: string, fileEnding: string, fileNameAndPath: string): string {
    const fileName = fileNameAndPath.split(/[\\\/]/).pop();
    const extractSource = path.join(localPathRoot, fileName);

    return extractSource;
}

function getSupportedFileEnding(file: string): string {
    for (const fileEnding of supportedFileEndings) {
        if (file.endsWith(fileEnding)) {
            return fileEnding;  
        }
    }
    throw new Error(taskLib.loc('UnsupportedFileExtension'));
}

/**
 * Install JDK.
 * @param sourceFile Path to JDK file.
 * @param fileExtension JDK file extension.
 * @param archiveExtractLocation Path to folder to extract a JDK.
 */
async function installJDK(sourceFile: string, fileExtension: string, archiveExtractLocation: string): Promise<string> {
    let jdkDirectory;
    if (fileExtension === '.dmg' && os.platform() === 'darwin') {
        // Using set because 'includes' array method requires tsconfig option "lib": ["ES2017"]
        const volumes: Set<string> = new Set(fs.readdirSync(VOLUMES_FOLDER));

        await attach(sourceFile);
    
        const newVolumes: string[] = fs.readdirSync(VOLUMES_FOLDER).filter(volume => !volumes.has(volume));
        if (newVolumes.length !== 1) {
            throw new Error(taskLib.loc('UnsupportedDMGArchiveStructure'));
        }
        const volumePath = path.join(VOLUMES_FOLDER, newVolumes[0]);

        let pkgPath: string = getPackagePath(volumePath);
        jdkDirectory = await installPkg(pkgPath);

        await detach(volumePath);
    }
    else if (fileExtension === '.pkg' && os.platform() === 'darwin') {
        jdkDirectory = await installPkg(sourceFile);
    }
    else {
        const javaFilesExtractor = new JavaFilesExtractor();
        jdkDirectory = await javaFilesExtractor.unzipJavaDownload(sourceFile, fileExtension, archiveExtractLocation);
    }
    return jdkDirectory;
}

/**
 * Get path to a .pkg file.
 * @param volumePath Path to the folder containing a .pkg file.
 */
function getPackagePath(volumePath: string): string {
    const packages: string[] = fs.readdirSync(volumePath).filter(file => file.endsWith('.pkg'));

    if (packages.length === 1) {
        return path.join(volumePath, packages[0]);
    } else if (packages.length === 0) {
        throw new Error(taskLib.loc('NoPKGFile'));
    } else {
        throw new Error(taskLib.loc('SeveralPKGFiles'));
    }
}

async function installPkg(pkgPath: string): Promise<string> {
    console.log(taskLib.loc('InstallJDK'));

    // Using set because 'includes' array method requires tsconfig option "lib": ["ES2017"]
    const JDKs: Set<string> = new Set(fs.readdirSync(JDK_FOLDER));

    await runPkgInstaller(pkgPath);

    const newJDKs = fs.readdirSync(JDK_FOLDER).filter(jdkName => !JDKs.has(jdkName));

    if (newJDKs.length !== 1) {
        throw new Error(taskLib.loc('NewJDKIsNotInstalled'));
    }

    let jdkDirectory: string = path.join(JDK_FOLDER, newJDKs[0], JDK_HOME_FOLDER);
    return jdkDirectory;
}

/**
 * Run a tool with `sudo` on Linux and macOS
 * Precondition: `toolName` executable is in PATH
 */
function sudo(toolName: string): ToolRunner {
    if (os.platform() === 'win32') {
        return taskLib.tool(toolName);
    } else {
        const toolPath = taskLib.which(toolName);
        return taskLib.tool('sudo').line(toolPath);
    }
}

/**
 * Attach a disk image.
 * @param sourceFile Path to JDK file.
 */
async function attach(sourceFile: string): Promise<void> {
    console.log(taskLib.loc('AttachDiskImage'));
    const hdiutil = sudo('hdiutil');
    hdiutil.line(`attach "${sourceFile}"`);
    await hdiutil.exec();
}

/**
 * Install a .pkg file.
 * @param pkgPath Path to a .pkg file.
 */
async function runPkgInstaller(pkgPath: string): Promise<void> {
    try {
        const installer = sudo('installer');
        installer.line(`-package "${pkgPath}" -target /`);
        await installer.exec();
    } catch (e) {
        taskLib.debug('Failed to install pkg file');
    }
}

/**
 * Detach a disk image.
 * @param volumePath Path to the folder containing a .pkg file.
 */
async function detach(volumePath: string): Promise<void> {
    console.log(taskLib.loc('DetachDiskImage'));
    const hdiutil = sudo('hdiutil');
    hdiutil.line(`detach "${volumePath}"`);
    await hdiutil.exec();
}

run();
