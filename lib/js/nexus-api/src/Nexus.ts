import * as types from './types';

import * as Promise from 'bluebird';
import * as fs from 'fs';
import * as restT from 'node-rest-client';
import request = require('request');

interface IRequestArgs {
  headers?: any;
  path?: any;
  data?: any;
  requestConfig?: {
    timeout: number,
    noDelay: boolean,
  };
  responseConfig?: {
    timeout: number,
  };
}

export class NexusError extends Error {
  private mStatusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.mStatusCode = statusCode;
  }

  public get statusCode() {
    return this.mStatusCode;
  }
}

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class HTTPError extends Error {
  constructor(statusCode: number, message: string) {
    super(`HTTP (${statusCode}) - ${message}`);
    this.name = this.constructor.name;
  }
}

/**
 * implements the Nexus API
 *
 * @class Nexus
 */
class Nexus {
  private mRestClient: restT.Client;
  private mBaseData: IRequestArgs;

  private mBaseURL = 'https://api.nexusmods.com/v1';

  constructor(game: string, apiKey: string, timeout?: number) {
    const { Client } = require('node-rest-client') as typeof restT;
    this.mRestClient = new Client();
    this.mBaseData = {
      headers: {
        'Content-Type': 'application/json',
        APIKEY: apiKey,
      },
      path: {
        gameId: game,
      },
      requestConfig: {
        timeout: timeout || 5000,
        noDelay: true,
      },
      responseConfig: {
        timeout: timeout || 5000,
      },
    };

    this.initMethods();
  }

  public setGame(gameId: string): void {
    this.mBaseData.path.gameId = gameId;
  }

  public setKey(apiKey: string): void {
    this.mBaseData.headers.APIKEY = apiKey;
  }

  public validateKey(key?: string): Promise<types.IValidateKeyResponse> {
    return new Promise<types.IValidateKeyResponse>((resolve, reject) => {
      const req = this.mRestClient.methods.validateKey(
        this.args({ headers: this.filter({ APIKEY: key }) }),
        (data, response) => this.handleResult(data, response, resolve, reject));
      req.on('requestTimeout', () => reject(new TimeoutError('validating key')));
      req.on('responesTimeout', () => reject(new TimeoutError('validateing key')));
      req.on('error', (err) => reject(err));
    });
  }

  public endorseMod(modId: number, modVersion: string,
                    endorseStatus: string, gameId?: string): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      this.mRestClient.methods.endorseMod(
        this.args({
          path: this.filter({ gameId, modId, endorseStatus }),
          data: this.filter({ Version: modVersion }),
        }),
        (data, response) => this.handleResult(data, response, resolve, reject));
    });
  }

  public getGames(): Promise<types.IGameListEntry[]> {
    return new Promise<types.IGameListEntry[]>((resolve, reject) => {
      const req = this.mRestClient.methods.getGames(this.args({}),
        (data, response) => this.handleResult(data, response, resolve, reject));
      req.on('requestTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('responesTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('error', (err) => reject(err));
    });
  }

  public getGameInfo(gameId?: string): Promise<types.IGameInfo> {
    return new Promise<types.IGameInfo>((resolve, reject) => {
      const req = this.mRestClient.methods.getGameInfo(
        this.args({ path: this.filter({ gameId }) }),
        (data, response) => this.handleResult(data, response, resolve, reject));
      req.on('requestTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('responesTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('error', (err) => reject(err));
    });
  }

  public getModInfo(modId: number, gameId?: string): Promise<types.IModInfo> {
    return new Promise<types.IModInfo>((resolve, reject) => {
      const req = this.mRestClient.methods.getModInfo(
        this.args({ path: this.filter({ modId, gameId }) }),
        (data, response) => this.handleResult(data, response, resolve, reject));
      req.on('requestTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('responesTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('error', (err) => reject(err));
    });
  }

  public getModFiles(modId: number, gameId?: string): Promise<types.IModFiles> {
    return new Promise<types.IModFiles>((resolve, reject) => {
      const req = this.mRestClient.methods.getModFiles(
        this.args({ path: this.filter({ modId, gameId }) }),
        (data, response) => this.handleResult(data, response, resolve, reject));
      req.on('requestTimeout', r => {
        r.abort();
        reject(new TimeoutError('contacting api ' + modId));
      });
      req.on('responesTimeout', res => reject(new TimeoutError('contacting api')));
      req.on('error', (err) => reject(err));
    });
  }

  public getFileInfo(modId: number,
                     fileId: number,
                     gameId?: string): Promise<types.IFileInfo> {
    return new Promise<types.IFileInfo>((resolve, reject) => {
      const req = this.mRestClient.methods.getFileInfo(
        this.args({ path: this.filter({ modId, fileId, gameId }) }),
        (data, response) => this.handleResult(data, response, resolve, reject));
      req.on('requestTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('responesTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('error', (err) => reject(err));
    });
  }

  public getDownloadURLs(modId: number,
                         fileId: number,
                         gameId?: string): Promise<types.IDownloadURL[]> {
    return new Promise<types.IDownloadURL[]>((resolve, reject) => {
      const req = this.mRestClient.methods.getDownloadURLs(
        this.args({ path: this.filter({ modId, fileId, gameId }) }),
        (data, response) => this.handleResult(data, response, resolve, reject));
      req.on('requestTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('responesTimeout', () => reject(new TimeoutError('contacting api')));
      req.on('error', (err) => reject(err));
    });
  }

  public sendFeedback(message: string,
                      fileBundle: string,
                      anonymous: boolean,
                      groupingKey?: string,
                      id?: string) {
    return new Promise<void>((resolve, reject) => {
      const formData = {
        feedback_text: message,
      };
      if (fileBundle !== undefined) {
        formData['feedback_file'] = fs.createReadStream(fileBundle);
      }
      if (groupingKey !== undefined) {
        formData['grouping_key'] = groupingKey;
      }
      if (id !== undefined) {
        formData['reference'] = id;
      }
      const headers = {};

      if (!anonymous) {
        headers['APIKEY'] = this.mBaseData.headers['APIKEY'];
      }

      const url = anonymous
        ? 'https://api.nexusmods.com/v1/feedbacks/anonymous'
        : 'https://api.nexusmods.com/v1/feedbacks';

      request.post({
        headers,
        url,
        formData,
        timeout: 30000,
      }, (error, response, body) => {
        if (error !== null) {
          return reject(error);
        } else if (response.statusCode >= 400) {
          return reject(new HTTPError(response.statusCode, response.statusMessage));
        } else {
          return resolve();
        }
      });
    });
  }

  private filter(obj: any): any {
    const result = {};
    Object.keys(obj).forEach((key) => {
      if (obj[key] !== undefined) {
        result[key] = obj[key];
      }
    });
    return result;
  }

  private handleResult(data, response, resolve, reject) {
    if ((response.statusCode >= 200) && (response.statusCode < 300)) {
      try {
        resolve(data);
      } catch (err) {
        reject(new Error('failed to parse server response: ' + err.message ));
      }
    } else {
      reject(new NexusError(data.message, response.statusCode));
    }
  }

  private args(customArgs: IRequestArgs) {
    const result: IRequestArgs = { ...this.mBaseData };
    for (const key of Object.keys(customArgs)) {
      result[key] = {
        ...result[key],
        ...customArgs[key],
      };
    }
    return result;
  }

  private initMethods() {
    // tslint:disable:no-invalid-template-strings
    this.mRestClient.registerMethod(
      'validateKey', this.mBaseURL + '/users/validate', 'GET');

    this.mRestClient.registerMethod(
      'getGames', this.mBaseURL + '/games', 'GET');

    this.mRestClient.registerMethod(
      'getGameInfo', this.mBaseURL + '/games/${gameId}', 'GET');

    this.mRestClient.registerMethod(
      'getModInfo', this.mBaseURL + '/games/${gameId}/mods/${modId}', 'GET');

    this.mRestClient.registerMethod(
      'getModFiles', this.mBaseURL + '/games/${gameId}/mods/${modId}/files', 'GET');

    this.mRestClient.registerMethod(
      'getFileInfo', this.mBaseURL + '/games/${gameId}/mods/${modId}/files/${fileId}', 'GET');

    this.mRestClient.registerMethod(
      'endorseMod', this.mBaseURL + '/games/${gameId}/mods/${modId}/${endorseStatus}', 'POST');

    this.mRestClient.registerMethod(
      'getDownloadURLs',
      this.mBaseURL + '/games/${gameId}/mods/${modId}/files/${fileId}/download_link', 'GET');
    // tslint:enable:no-invalid-template-string
  }
}

export default Nexus;
