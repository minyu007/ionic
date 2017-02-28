import { dirname, join, relative } from 'path';
import { readFileSync } from 'fs';

import * as glob from 'glob';
import { task } from 'gulp';
import * as del from 'del';
import { template } from 'lodash';
import * as runSequence from 'run-sequence';
import { argv } from 'yargs';


import { ES_2015, PROJECT_ROOT, SRC_ROOT, SRC_COMPONENTS_ROOT, SCRIPTS_ROOT } from '../constants';
import { createTempTsConfig, getFolderInfo, readFileAsync, runAppScriptsBuild, writeFileAsync, writePolyfills } from '../util';

import * as pAll from 'p-all';

task('e2e.prepare', (done: Function) => {
  runSequence('e2e.clean', 'e2e.polyfill', (err: any) => done(err));
});

task('e2e.prod', ['e2e.prepare'], (done: Function) => {

  // okay, first find out all of the e2e tests to run by finding all of the 'main.ts' files
  filterE2eTestfiles().then((filePaths: string[]) => {
    console.log(`Compiling ${filePaths.length} E2E tests ...`);
    return buildTests(filePaths);
  }).then(() => {
    done();
  }).catch((err: Error) => {
    done(err);
  });
});

function filterE2eTestfiles() {
  return getE2eTestFiles().then((filePaths: string[]) => {
    const entryPoints = filePaths.map(filePath => {
      const directoryName = dirname(filePath);
      return join(directoryName, 'app', 'main.ts');
    });
    return entryPoints;
  }).then((entryPoints: string[]) => {
    const folderInfo = getFolderInfo();
    if (folderInfo && folderInfo.componentName && folderInfo.componentTest) {
      const filtered = entryPoints.filter(entryPoint => {
        return entryPoint.indexOf(folderInfo.componentName) >= 0 && entryPoint.indexOf(folderInfo.componentTest) >= 0;
      });
      return filtered;
    }
    return entryPoints;
  });
}

function getE2eTestFiles() {
  return new Promise((resolve, reject) => {
    const mainGlob = join(SRC_COMPONENTS_ROOT, '*', 'test', '*', 'e2e.ts');
    glob(mainGlob, (err: Error, matches: string[]) => {
      if (err) {
        return reject(err);
      }
      resolve(matches);
    });
  });
}


function buildTests(filePaths: string[]) {
  const functions = filePaths.map(filePath => () => {
    return buildTest(filePath);
  });
  return pAll(functions, {concurrency: 8}).then(() => {
    // copy over all of the protractor tests to the correct location now
    return copyProtractorTestContent(filePaths);
  });
}

function buildTest(filePath: string) {
  const start = Date.now();
  const ionicAngularDir = join(process.cwd(), 'src');
  const srcTestRoot = dirname(filePath);
  const relativePathFromComponents = relative(dirname(SRC_COMPONENTS_ROOT), srcTestRoot);
  const distTestRoot = join(process.cwd(), 'dist', 'e2e', relativePathFromComponents);

  const includeGlob = [ join(ionicAngularDir, '**', '*.ts')];
  const pathToWriteFile = join(distTestRoot, 'tsconfig.json');
  const pathToReadFile = join(PROJECT_ROOT, 'tsconfig.json');

  createTempTsConfig(includeGlob, ES_2015, ES_2015, pathToReadFile, pathToWriteFile, { removeComments: true});

  const sassConfigPath = join('scripts', 'e2e', 'sass.config.js');
  const copyConfigPath = join('scripts', 'e2e', 'copy.config.js');

  const appEntryPoint = filePath;
  const appNgModulePath = join(srcTestRoot, 'app.module.ts');
  const distDir = join(distTestRoot, 'www');

  return runAppScriptsBuild(appEntryPoint, appNgModulePath, ionicAngularDir, distDir, pathToWriteFile, ionicAngularDir, sassConfigPath, copyConfigPath).then(() => {
    const end = Date.now();
    console.log(`${filePath} took a total of ${(end - start) / 1000} seconds to build`);
  });
}

function copyProtractorTestContent(filePaths: string[]): Promise<any> {
  return readE2ETestFiles(filePaths)
    .then((map: Map<string, string>) => {
      return applyTemplate(map);
    }).then((map: Map<string, string>) => {
      writeE2EJsFiles(map);
    });
}

function applyTemplate(filePathContent: Map<string, string>) {
  const buildConfig = require('../../build/config');
  const templateFileContent = readFileSync(join(SCRIPTS_ROOT, 'e2e', 'e2e.template.js'));
  const templater = template(templateFileContent.toString());
  const modifiedMap = new Map<string, string>();
  const platforms = ['android', 'ios', 'windows'];
  filePathContent.forEach((fileContent: string, filePath: string) => {
    const srcRelativePath = relative(SRC_ROOT, dirname(filePath));
    const wwwRelativePath = join(srcRelativePath, 'www');
    platforms.forEach(platform => {
      const platformContents = templater({
        contents: fileContent,
        buildConfig: buildConfig,
        relativePath: wwwRelativePath,
        platform: platform,
        relativePathBackwardsCompatibility: dirname(wwwRelativePath)
      });
      const newFilePath = join(wwwRelativePath, `${platform}.e2e.js`);
      modifiedMap.set(newFilePath, platformContents);
    });
  });
  return modifiedMap;
}

function writeE2EJsFiles(map: Map<string, string>) {
  const promises: Promise<any>[] = [];
  map.forEach((fileContent: string, filePath: string) => {
    const destination = join(process.cwd(), 'dist', 'e2e', filePath);
    promises.push(writeFileAsync(destination, fileContent));
  });
  return Promise.all(promises);
}


function readE2ETestFiles(mainFilePaths: string[]): Promise<Map<string, string>> {
  const e2eFiles = mainFilePaths.map(mainFilePath => {
    return join(dirname(mainFilePath), 'e2e.ts');
  });

  const promises: Promise<any>[] = [];
  const map = new Map<string, string>();
  for (const e2eFile of e2eFiles) {
    const promise = readE2EFile(e2eFile);
    promises.push(promise);
    promise.then((content: string) => {
      map.set(e2eFile, content);
    });
  }

  return Promise.all(promises).then(() => {
    return map;
  });
}

function readE2EFile(filePath: string) {
  return readFileAsync(filePath).then((content: string) => {
    // purge the import statement at the top
    const purgeImportRegex = /.*?import.*?'protractor';/g;
    return content.replace(purgeImportRegex, '');
  });
}



task('e2e.clean', (done: Function) => {
  // this is a super hack, but it works for now
  if (argv.skipClean) {
    return done();
  }

  del(['dist/e2e/**']).then(() => {
    done();
  }).catch(err => {
    done(err);
  });
});

task('e2e.polyfill', (done: Function) => {
  if (argv.skipPolyfill) {
    return done();
  }

  writePolyfills('dist/e2e/polyfills').then(() => {
    done();
  }).catch(err => {
    done(err);
  });
});
