import { IExtensionApi, IExtensionContext } from '../../types/IExtensionContext';
import { IState } from '../../types/IState';
import { getNormalizeFunc, Normalize, UserCanceled } from '../../util/api';
import Debouncer from '../../util/Debouncer';
import * as fs from '../../util/fs';
import { log } from '../../util/log';
import ReduxProp from '../../util/ReduxProp';
import * as selectors from '../../util/selectors';
import { getSafe } from '../../util/storeHelper';
import { sum, truthy } from '../../util/util';

import {
  addLocalDownload,
  removeDownload,
  setDownloadHashByFile,
  setDownloadInterrupted,
  setDownloadModInfo,
  setDownloadSpeed,
  setDownloadSpeeds,
  downloadProgress,
} from './actions/state';
import { settingsReducer } from './reducers/settings';
import { stateReducer } from './reducers/state';
import { IDownload } from './types/IDownload';
import { IProtocolHandlers } from './types/ProtocolHandlers';
import getDownloadGames from './util/getDownloadGames';
import DownloadView from './views/DownloadView';
import Settings from './views/Settings';
import SpeedOMeter from './views/SpeedOMeter';

import DownloadManager from './DownloadManager';
import observe, { DownloadObserver } from './DownloadObserver';

import * as Promise from 'bluebird';
import { app as appIn, remote } from 'electron';
import * as _ from 'lodash';
import * as path from 'path';
import * as Redux from 'redux';
import {generate as shortid} from 'shortid';

const app = remote !== undefined ? remote.app : appIn;

let observer: DownloadObserver;
let manager: DownloadManager;

const protocolHandlers: IProtocolHandlers = {};

const archiveExtLookup = new Set<string>([
  '.zip', '.z01', '.7z', '.rar', '.r00', '.001', '.bz2', '.bzip2', '.gz', '.gzip',
  '.xz', '.z',
  '.fomod',
]);

function knownArchiveExt(filePath: string): boolean {
  if (!truthy(filePath)) {
    return false;
  }
  return archiveExtLookup.has(path.extname(filePath).toLowerCase());
}

function refreshDownloads(downloadPath: string, knownDLs: string[],
                          normalize: (input: string) => string,
                          onAddDownload: (name: string) => Promise<void>,
                          onRemoveDownload: (name: string) => Promise<void>,
                          confirmElevation: () => Promise<void>) {
  return fs.ensureDirWritableAsync(downloadPath, confirmElevation)
    .then(() => fs.readdirAsync(downloadPath))
    .filter((filePath: string) => knownArchiveExt(filePath))
    .filter((filePath: string) =>
      fs.statAsync(path.join(downloadPath, filePath))
      .then(stat => !stat.isDirectory()).catch(() => false))
    .then((downloadNames: string[]) => {
      const dlsNormalized = downloadNames.map(normalize);
      const addedDLs = downloadNames.filter((name: string, idx: number) =>
        knownDLs.indexOf(dlsNormalized[idx]) === -1);
      const removedDLs = knownDLs.filter((name: string) =>
        dlsNormalized.indexOf(name) === -1);

      return Promise.map(addedDLs, onAddDownload)
        .then(() => Promise.map(removedDLs, onRemoveDownload));
    });
}

export type ProtocolHandler = (inputUrl: string) => Promise<string[]>;

export interface IExtensionContextExt extends IExtensionContext {
  // register a download protocol handler
  // TODO: these kinds of handlers are rather limited as they can only return
  // ftp/http/https urls that can be downloaded directly, you can't add
  // meta information about the file.
  registerDownloadProtocol: (schema: string, handler: ProtocolHandler) => void;
}

function attributeExtractor(input: any) {
  let downloadGame: string | string[] = getSafe(input, ['download', 'game'], []);
  if (Array.isArray(downloadGame)) {
    downloadGame = downloadGame[0];
  }
  return Promise.resolve({
    fileName: getSafe(input, ['download', 'localPath'], undefined),
    fileMD5: getSafe(input, ['download', 'fileMD5'], undefined),
    fileSize: getSafe(input, ['download', 'size'], undefined),
    source: getSafe(input, ['download', 'modInfo', 'source'], undefined),
    version: getSafe(input, ['download', 'modInfo', 'version'], undefined),
    logicalFileName: getSafe(input, ['download', 'modInfo', 'name'], undefined),
    downloadGame,
  });
}

function attributeExtractorCustom(input: any) {
  return Promise.resolve({
    category: getSafe(input, ['download', 'modInfo', 'custom', 'category'], undefined),
  });
}

function genDownloadChangeHandler(api: IExtensionApi,
                                  currentDownloadPath: string,
                                  gameId: string,
                                  nameIdMap: { [name: string]: string },
                                  normalize: Normalize) {
  const updateTimers: { [fileName: string]: NodeJS.Timer } = {};

  const store: Redux.Store<any> = api.store;

  const findDownload = (fileName: string): string => {
    const state = store.getState()
    return Object.keys(state.persistent.downloads.files)
      .find(iterId =>
        state.persistent.downloads.files[iterId].localPath === fileName);
  }

  return (evt: string, fileName: string) => {
    if (!watchEnabled
        || (fileName === undefined)
        || !knownArchiveExt(fileName)) {
      return;
    }

    if (evt === 'update') {
      if (updateTimers[fileName] !== undefined) {
        clearTimeout(updateTimers[fileName]);
        setTimeout(() => {
          fs.statAsync(path.join(currentDownloadPath, fileName))
            .then(stats => {
              const dlId = findDownload(fileName);
              if (dlId !== undefined) {
                store.dispatch(downloadProgress(dlId, stats.size, stats.size, [], undefined));
              }
            });
        }, 5000);
      }
    } else if (evt === 'rename') {
      // this delay is intended to prevent this from picking up files that Vortex added itself.
      // It is not enough however to prevent this from getting the wrong file size if the file
      // copy/write takes more than this one second.
      Promise.delay(1000)
        .then(() => fs.statAsync(path.join(currentDownloadPath, fileName)))
        .then(stats => {
          let dlId = findDownload(fileName);
          if (dlId === undefined) {
            dlId = shortid();
            store.dispatch(addLocalDownload(dlId, gameId, fileName, stats.size));
            api.events.emit('did-import-downloads', [dlId]);
          }
          nameIdMap[normalize(fileName)] = dlId;
        })
        .catch(err => {
          if ((err.code === 'ENOENT') && (nameIdMap[normalize(fileName)] !== undefined)) {
            // if the file was deleted, remove it from state. This does nothing if
            // the download was already removed so that's fine
            store.dispatch(removeDownload(nameIdMap[normalize(fileName)]));
          }
        });
    }
  };
}

let currentWatch: fs.FSWatcher;
let watchEnabled: boolean = true;

function watchDownloads(api: IExtensionApi, downloadPath: string,
                        onChange: (evt: string, fileName: string) => void) {
  if (currentWatch !== undefined) {
    currentWatch.close();
  }

  try {
    currentWatch = fs.watch(downloadPath, {}, onChange) as fs.FSWatcher;
    currentWatch.on('error', error => {
      // these may happen when the download path gets moved.
        log('warn', 'failed to watch mod directory', { downloadPath, error });
    });
  } catch (err) {
    api.showErrorNotification('Can\'t watch the download directory for changes', err, {
      allowReport: false,
    });
  }
}

function updateDownloadPath(api: IExtensionApi, gameId?: string) {
  const { store } = api;

  const state: IState = store.getState();

  let downloads: {[id: string]: IDownload} = state.persistent.downloads.files;

  // workaround to avoid duplicate entries in the download list. These should not
  // exist, the following block should do nothing
  Object.keys(downloads)
    .filter(dlId => (downloads[dlId].state === 'finished')
                    && !truthy(downloads[dlId].localPath))
    .forEach(dlId => {
      api.store.dispatch(removeDownload(dlId));
    });

  downloads = state.persistent.downloads.files;

  if (gameId === undefined) {
    gameId = selectors.activeGameId(state);
    if (gameId === undefined) {
      return Promise.resolve();
    }
  }
  const currentDownloadPath = selectors.downloadPathForGame(state, gameId);

  let nameIdMap: {[name: string]: string} = {};

  let downloadChangeHandler: (evt: string, fileName: string) => void;
  return getNormalizeFunc(currentDownloadPath, {separators: false, relative: false})
      .then(normalize => {
        nameIdMap = Object.keys(downloads).reduce((prev, value) => {
          if (downloads[value].localPath !== undefined) {
            prev[normalize(downloads[value].localPath)] = value;
          }
          return prev;
        }, {});

        downloadChangeHandler =
          genDownloadChangeHandler(api, currentDownloadPath, gameId, nameIdMap, normalize);

        const knownDLs =
          Object.keys(downloads)
            .filter(dlId => getDownloadGames(downloads[dlId])[0] === gameId)
            .map(dlId => normalize(downloads[dlId].localPath || ''));

        return refreshDownloads(currentDownloadPath, knownDLs, normalize,
          (fileName: string) =>
            fs.statAsync(path.join(currentDownloadPath, fileName))
              .then((stats: fs.Stats) => {
                const dlId = shortid();
                store.dispatch(addLocalDownload(dlId, gameId, fileName, stats.size));
                nameIdMap[normalize(fileName)] = dlId;
              }),
          (fileName: string) => {
            // the fileName here is already normalized
            api.store.dispatch(removeDownload(nameIdMap[fileName]));
            return Promise.resolve();
          },
          () => new Promise((resolve, reject) => {
            api.showDialog('question', 'Access Denied', {
              text: 'The download directory is not writable to your user account.\n'
                + 'If you have admin rights on this system, Vortex can change the permissions '
                + 'to allow it write access.',
            }, [
                { label: 'Cancel', action: () => reject(new UserCanceled()) },
                { label: 'Allow access', action: () => resolve() },
              ]);
          }))
          .catch(UserCanceled, () => null)
          .catch(err => {
            api.showErrorNotification('Failed to refresh download directory', err, {
              allowReport: err.code !== 'EPERM',
            });
          });
      })
    .then(() => {
      manager.setDownloadPath(currentDownloadPath);
      watchDownloads(api, currentDownloadPath, downloadChangeHandler);
      api.events.emit('downloads-refreshed');
    })
    .catch(err => {
      api.showErrorNotification('Failed to read downloads directory',
          err, { allowReport: err.code !== 'ENOENT' });
    });
}

function genGameModeActivated(api: IExtensionApi) {
  return () => updateDownloadPath(api);
}

function removeArchive(store: Redux.Store<IState>, destination: string) {
  return fs.removeAsync(destination)
    .then(() => {
      const state = store.getState();
      const fileName = path.basename(destination);
      const { files } = state.persistent.downloads;
      Object.keys(files)
        .filter(dlId => files[dlId].localPath === fileName)
        .forEach(dlId => {
          store.dispatch(removeDownload(dlId));
        })
    });
}

function queryReplace(api: IExtensionApi, destination: string) {
  return api.showDialog('question', 'File exists', {
    text: 'This file already exists, do you want to replace it?',
    message: destination,
  }, [
    { label: 'Cancel' },
    { label: 'Replace' },
  ])
  .then(result => (result.action === 'Cancel')
    ? Promise.reject(new UserCanceled())
    : removeArchive(api.store, destination));
}

function move(api: IExtensionApi, source: string, destination: string): Promise<void> {
  const store = api.store;
  const gameMode = selectors.activeGameId(store.getState());

  const notiId = api.sendNotification({
    type: 'activity',
    title: 'Importing file',
    message: path.basename(destination),
  });
  const dlId = shortid();
  return fs.statAsync(destination)
    .catch(() => undefined)
    .then(stats => stats !== undefined ? queryReplace(api, destination) : null)
    .then(() => {
      store.dispatch(addLocalDownload(dlId, gameMode, path.basename(destination), 0));
    })
    .then(() => fs.copyAsync(source, destination))
    .then(() => fs.statAsync(destination))
    .then(stats => {
      api.dismissNotification(notiId);
      store.dispatch(downloadProgress(dlId, stats.size, stats.size, [], undefined));
      api.events.emit('did-import-download', [dlId]);
    })
    .catch(err => {
      api.dismissNotification(notiId);
      store.dispatch(removeDownload(dlId));
      log('info', 'failed to copy', {error: err.message});
    });
}

function genImportDownloadsHandler(api: IExtensionApi) {
  return (downloadPaths: string[]) => {
    const downloadPath = selectors.downloadPath(api.store.getState());
    let hadDirs = false;
    Promise.map(downloadPaths, dlPath => {
      const fileName = path.basename(dlPath);
      const destination = path.join(downloadPath, fileName);
      return fs.statAsync(dlPath)
        .then(stats => {
          if (stats.isDirectory()) {
            hadDirs = true;
            return Promise.resolve();
          } else {
            return move(api, dlPath, destination);
          }
        })
        .then(() => {
          if (hadDirs) {
            api.sendNotification({
              type: 'warning',
              title: 'Can\'t import directories',
              message:
                'You can drag mod archives here, directories are not supported',
            });
          }
          log('info', 'imported archives', { count: downloadPaths.length });
        })
        .catch(err => {
          api.sendNotification({
            type: 'warning',
            title: err.code === 'ENOENT' ? 'File doesn\'t exist' : err.message,
            message: dlPath,
          });
        });
    });
  };
}

function init(context: IExtensionContextExt): boolean {
  const downloadCount = new ReduxProp(context.api, [
    ['persistent', 'downloads', 'files'],
    ], (downloads: { [dlId: string]: IDownload }) => {
      const count = Object.keys(downloads).filter(
        id => ['init', 'started', 'paused'].indexOf(downloads[id].state) !== -1).length;
      return count > 0 ? count : undefined;
    });

  context.registerMainPage('download', 'Downloads', DownloadView, {
                             hotkey: 'D',
                             group: 'global',
                             badge: downloadCount,
                           });

  context.registerSettings('Download', Settings);

  context.registerFooter('speed-o-meter', SpeedOMeter);

  context.registerReducer(['persistent', 'downloads'], stateReducer);
  context.registerReducer(['settings', 'downloads'], settingsReducer);

  context.registerDownloadProtocol = (schema: string, handler: ProtocolHandler) => {
    protocolHandlers[schema] = handler;
  };

  context.registerAttributeExtractor(150, attributeExtractor);
  context.registerAttributeExtractor(25, attributeExtractorCustom);
  context.registerActionCheck('SET_DOWNLOAD_FILEPATH', (state, action: any) => {
    if (action.payload === '') {
      return 'Attempt to set invalid file name for a download';
    }
    return undefined;
  });

  context.once(() => {
    const DownloadManagerImpl: typeof DownloadManager = require('./DownloadManager').default;
    const observeImpl: typeof observe = require('./DownloadObserver').default;

    const store = context.api.store;

    // undo an earlier bug where vortex registered itself as the default http/https handler
    // (fortunately few applications actually rely on that setting, unfortunately this meant
    // the bug wasn't found for a long time)
    context.api.deregisterProtocol('http');
    context.api.deregisterProtocol('https');

    context.api.registerProtocol('http', false, url => {
      context.api.events.emit('start-download', [url], {});
    });

    context.api.registerProtocol('https', false, url => {
      context.api.events.emit('start-download', [url], {});
    });

    context.api.events.on('will-move-downloads', () => {
      if (currentWatch !== undefined) {
        currentWatch.close();
        currentWatch = undefined;
      }
    });

    context.api.onStateChange(['settings', 'downloads', 'path'], (prev, cur) => {
      updateDownloadPath(context.api);
    });

    context.api.onStateChange(['persistent', 'downloads', 'files'],
        (prev: { [dlId: string]: IDownload }, cur: { [dlId: string]: IDownload }) => {
      // when files are added without mod info, query the meta database
      const added = _.difference(Object.keys(cur), Object.keys(prev));
      const filtered = added.filter(
        dlId => (cur[dlId].state === 'finished') && (Object.keys(cur[dlId].modInfo).length === 0));

      const state: IState = context.api.store.getState();

      Promise.map(filtered, dlId => {
        const downloadPath = selectors.downloadPathForGame(state, getDownloadGames(cur[dlId])[0]);
        context.api.lookupModMeta({ filePath: path.join(downloadPath, cur[dlId].localPath) })
          .then(result => {
            if (result.length > 0) {
              const info = result[0].value;
              store.dispatch(setDownloadModInfo(dlId, 'game', info.gameId));
              store.dispatch(setDownloadModInfo(dlId, 'version', info.fileVersion));
              if (info.logicalFileName || info.fileName) {
                store.dispatch(setDownloadModInfo(dlId, 'name',
                  info.logicalFileName || info.fileName));
              }
            }
          })
          .catch(err => {
            log('warn', 'failed to look up mod info', err.message);
          });
      });
    });

    context.api.events.on('gamemode-activated', genGameModeActivated(context.api));

    context.api.events.on('filehash-calculated',
      (filePath: string, fileMD5: string, fileSize: number) => {
        context.api.store.dispatch(setDownloadHashByFile(path.basename(filePath),
                                   fileMD5, fileSize));
      });

    context.api.events.on('enable-download-watch', (enabled: boolean) => {
      watchEnabled = enabled;
    });

    context.api.events.on('refresh-downloads', (gameId: string, callback: (err) => void) => {
      updateDownloadPath(context.api, gameId)
        .then(() => {
          if (callback !== undefined) {
            callback(null);
           }
        })
        .catch(err => {
          if (callback !== undefined) {
            callback(err);
          }
        });
    });

    context.api.events.on('import-downloads', genImportDownloadsHandler(context.api));

    {
      let speedsDebouncer = new Debouncer(() => {
        store.dispatch(setDownloadSpeeds(store.getState().persistent.downloads.speedHistory));
        return null;
      }, 10000, false);
      manager = new DownloadManagerImpl(
          selectors.downloadPath(store.getState()),
          store.getState().settings.downloads.maxParallelDownloads,
          store.getState().settings.downloads.maxChunks, (speed: number) => {
            if ((speed !== 0) || (store.getState().persistent.downloads.speed !== 0)) {
              // this first call is only applied in the renderer for performance reasons
              store.dispatch(setDownloadSpeed(speed));
              // this schedules the main progress to be updated
              speedsDebouncer.schedule();
            }
          }, `Nexus Client v2.${app.getVersion()}`);
      observer =
          observeImpl(context.api.events, store, manager, protocolHandlers);

      const downloads = (store.getState() as IState).persistent.downloads.files;
      const interruptedDownloads = Object.keys(downloads)
        .filter(id => ['init', 'started', 'pending'].indexOf(downloads[id].state) !== -1);
      interruptedDownloads.forEach(id => {
        if (!truthy(downloads[id].urls)) {
          // download was interrupted before receiving urls, has to be canceled
          log('info', 'download removed because urls were never retrieved', { id });
          const downloadPath = selectors.downloadPath(context.api.store.getState());
          if ((downloadPath !== undefined) && (downloads[id].localPath !== undefined)) {
            fs.removeAsync(path.join(downloadPath, downloads[id].localPath))
              .then(() => {
                store.dispatch(removeDownload(id));
              });
          } else {
            store.dispatch(removeDownload(id));
          }
        } else {
          let realSize = (downloads[id].size !== 0)
            ? downloads[id].size - sum((downloads[id].chunks || []).map(chunk => chunk.size))
            : 0;
          if (isNaN(realSize)) {
            realSize = 0;
          }
          store.dispatch(setDownloadInterrupted(id, realSize));
        }
      });
      // remove downloads that have no localPath set because they just cause trouble. They shouldn't
      // exist at all
      Object.keys(downloads)
        .filter(dlId => !truthy(downloads[dlId].localPath))
        .forEach(dlId => {
          store.dispatch(removeDownload(dlId));
        });
    }
  });

  return true;
}

export default init;
