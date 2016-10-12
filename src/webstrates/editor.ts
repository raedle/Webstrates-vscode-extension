import * as vscode from 'vscode';

const path = require('path');
var elegantSpinner = require('elegant-spinner');
var frame = elegantSpinner();

import Logger from '../utils/logger';
import Timer from '../utils/timer';
import WebstratesClient from './webstrates-client';
import FileDocument from './file-document';
import WebstratePreviewDocumentContentProvider from './content-provider';
import { WebstratesErrorCodes } from './error-codes';
import { Utils } from './utils';

export default class WebstratesEditor {

  // Logger to log info, debug, error, and warn messages.
  private static Log: Logger = Logger.getLogger(WebstratesEditor);

  private static StatusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
  private static ClientStatusBarItem: vscode.StatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 2);

  private context: vscode.ExtensionContext;
  private client: WebstratesClient;
  private previewUri: vscode.Uri;

  private static timer: Timer;
  private static spinnerTimer: Timer;

  // Spinner interval -> used in status bar to show a progressing spinner before message.
  private static statusBarSpinnerInterval: any;

  /**
   * @param  {vscode.ExtensionContext} context
   */
  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Connect to Webstrates server.
    this.connectToServer();

    this.initCommands();
    this.initEvents();
    this.initPreview();
    this.initOutput();

    // Show a 3 seconds status message that Webstrates editor has sucessfully loaded.
    vscode.window.setStatusBarMessage("Webstrates Editor successfully loaded.", 3000);
  }

  /**
   * Connect to Webstrates server.
   * 
   * @private
   * 
   * @memberOf WebstratesEditor
   */
  private connectToServer() {

    const { serverAddress, reconnect, reconnectTimeout, deleteLocalFilesOnClose } = Utils.loadWorkspaceConfig();

    // Close existing connection to server.
    if (this.client) {
      this.client.dispose(deleteLocalFilesOnClose)
    }

    this.client = new WebstratesClient(serverAddress);

    this.client.onDidConnect(() => {
      WebstratesEditor.SetClientStatus(`Connected to ${serverAddress}`);

      // On extension activate, also try to receive webstrate document of currently opened file document.
      if (vscode.window.activeTextEditor) {
        const document = vscode.window.activeTextEditor.document;
        this.openDocumentWebstrate(document);
      }
    });

    this.client.onDidDisconnect(() => {
      WebstratesEditor.SetClientStatus(`Disconnected from ${serverAddress}`);

      this.client.dispose(deleteLocalFilesOnClose);

      if (reconnect) {
        WebstratesEditor.SetClientStatus(`Reconnecting`, reconnectTimeout / 1000);

        // Try to reconnect after 10s timeout.
        const timer = new Timer(reconnectTimeout);
        timer.onElapsed(() => {
          this.connectToServer();
        });
        timer.start();
      }
    });
  }

  /**
   * Initialize editor commands.
   * 
   * @private
   * 
   * @memberOf WebstratesEditor
   */
  private initCommands() {
    const initWorkspaceDisposable = vscode.commands.registerCommand('webstrates.initWorkspace', () => this.initWorkspace());
    const openDisposable = vscode.commands.registerCommand('webstrates.openWebstrate', () => this.openWebstrate());
    const webstratePreviewDisposable = vscode.commands.registerCommand('webstrates.webstratePreview', () => this.webstratePreview());

    this.context.subscriptions.push(initWorkspaceDisposable, openDisposable, webstratePreviewDisposable);
  }

  /**
   * Initialize editor events.
   * 
   * @private
   * 
   * @memberOf WebstratesEditor
   */
  private initEvents() {

    // // On extension activate, also try to receive webstrate document of currently opened file document.
    // if (vscode.window.activeTextEditor) {
    //   const document = vscode.window.activeTextEditor.document;
    //   this.openDocumentWebstrate(document);
    // }

    // Open webstrate document of any opened file document.
    const openTextDocumentDisposable = vscode.workspace.onDidOpenTextDocument((textDocument: vscode.TextDocument) => this.openDocumentWebstrate(textDocument));
    const saveDisposable = vscode.workspace.onDidSaveTextDocument((textDocument: vscode.TextDocument) => this.saveWebstrate(textDocument));
    const closeDisposable = vscode.workspace.onDidCloseTextDocument((textDocument: vscode.TextDocument) => this.closeWebstrate(textDocument));

    this.context.subscriptions.push(openTextDocumentDisposable, saveDisposable, closeDisposable);
  }

  /**
   * Initialize preview window.
   * 
   * @private
   * 
   * @memberOf WebstratesEditor
   */
  private initPreview() {
    this.previewUri = vscode.Uri.parse('webstrate-preview://authority/webstrate-preview');
    let provider = new WebstratePreviewDocumentContentProvider();
    let registration = vscode.workspace.registerTextDocumentContentProvider('webstrate-preview', provider);

    const changeTextDocumentDisposable = vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
      if (e.document === vscode.window.activeTextEditor.document) {
        provider.update(this.previewUri);
      }
    });

    const changeActiveTextEditorDisposable = vscode.window.onDidChangeActiveTextEditor((textEditor: vscode.TextEditor) => {
      provider.update(this.previewUri);
    });

    this.context.subscriptions.push(registration, changeTextDocumentDisposable, changeActiveTextEditorDisposable);
  }

  /**
   * Initialize output channel and status bar. The output channel is mostly important for developing and debugging
   * the extension, but could be useful at some point to report bugs. It will be hidden by default.
   * 
   * @private
   * 
   * @memberOf WebstratesEditor
   */
  private initOutput() {
    // show 'Webstrates' output channel in UI
    // WebstratesEditor.OutputChannel.show();

    // Show 'Webstrates' status bar item in UI.
    WebstratesEditor.StatusBarItem.show();
    WebstratesEditor.ClientStatusBarItem.show();
  }

  /**
   * Initialize Webstrates workspace. 
   */
  private initWorkspace() {
    Utils.initWorkspace();
  }

  private onFileDocumentConnect: any;
  private onFileDocumentDisconnect: any;
  private onFileDocumentNew: any;
  private onFileDocumentUpdate: any;
  private onFileDocumentUpdateOp: any;
  private onFileDocumentError: any;

  /**
   * 
   * 
   * @private
   * @param {vscode.TextDocument} document
   * @returns
   * 
   * @memberOf WebstratesEditor
   */
  private openDocumentWebstrate(textDocument: vscode.TextDocument) {

    if (this.onFileDocumentConnect) {
      this.onFileDocumentConnect.dispose();
    }

    if (this.onFileDocumentDisconnect) {
      this.onFileDocumentDisconnect.dispose();
    }

    if (this.onFileDocumentNew) {
      this.onFileDocumentNew.dispose();
    }

    if (this.onFileDocumentUpdate) {
      this.onFileDocumentUpdate.dispose();
    }

    if (this.onFileDocumentUpdateOp) {
      this.onFileDocumentUpdateOp.dispose();
    }

    if (this.onFileDocumentError) {
      this.onFileDocumentError.dispose();
    }

    // TODO on data events to show active data transmission.

    // Get webstrate file document, which relates to the text document.
    this.client.getFileDocument(textDocument).then(fileDocument => {
      this.onFileDocumentConnect = fileDocument.onDidConnect(() => {
        WebstratesEditor.SetStatus('Sync', 1000); // Placeholder message
      });

      this.onFileDocumentDisconnect = fileDocument.onDidDisconnect(() => {
        WebstratesEditor.SetStatus('Sync', -1); // Placeholder message
      });

      this.onFileDocumentNew = fileDocument.onNew(() => {
        vscode.window.showWarningMessage(WebstratesErrorCodes.WebstrateNotFound.errorTemplate(fileDocument.id));
      });

      this.onFileDocumentUpdate = fileDocument.onUpdate(() => {
        WebstratesEditor.SetStatus('Sync', 3000);
      });

      this.onFileDocumentUpdateOp = fileDocument.onUpdateOp(() => {
        WebstratesEditor.SetStatus('Sync', 3000);
      });

      this.onFileDocumentError = fileDocument.onError(error => {
        WebstratesEditor.SetStatus('Error'); // Placeholder message

        if (!error) {
          vscode.window.showErrorMessage('Unknown Error');
          return;
        }

        let thenable: Thenable<string> = null;
        switch (error.code) {
          case WebstratesErrorCodes.AccessForbidden.code:
            thenable = vscode.window.showErrorMessage(WebstratesErrorCodes.AccessForbidden.errorTemplate(fileDocument.id));
            break;
          case WebstratesErrorCodes.WebstrateNotFound.code:
            thenable = vscode.window.showWarningMessage(WebstratesErrorCodes.WebstrateNotFound.errorTemplate(fileDocument.id));
            break;
          case WebstratesErrorCodes.InternalServerError.code:
            thenable = vscode.window.showErrorMessage(WebstratesErrorCodes.InternalServerError.errorTemplate());
            break;
        }
      });
    });
  }

  /**
   * Open Webstrates webstrate.
   */
  private openWebstrate(webstrateId: string = null, document: vscode.TextDocument = null) {

    let workspacePath = vscode.workspace.rootPath;
    if (!workspacePath) {
      vscode.window.showInformationMessage('Open workspace first.');
      return;
    }

    if (!webstrateId) {
      this.webstrateIdInput()
        .then(webstrateId => {

          // webstrateId will be 'undefined' on cancel input
          if (!webstrateId) {
            return;
          }

          const filePath = path.join(workspacePath, `${webstrateId}`);

          WebstratesEditor.SetStatus(`Requesting ${webstrateId}`);

          this.client.requestWebstrate(webstrateId, filePath);
        });
    }
    else {
      const filePath = document.fileName;

      WebstratesEditor.SetStatus(`Requesting ${webstrateId}`);

      this.client.requestWebstrate(webstrateId, filePath);
    }
  }

  /**
   * Closes the webstrate associated with the text document.
   * 
   * @param  {} textDocument
   */
  private closeWebstrate(textDocument) {
    // vscode.window.showInformationMessage('close text doc');

    const config = Utils.loadWorkspaceConfig();
    // const deleteLocalFile = typeof config.deleteLocalFilesOnClose === "undefined" ? true : config.deleteLocalFilesOnClose;
    const deleteLocalFile = !!config.deleteLocalFilesOnClose;

    this.client.closeWebstrate(textDocument, deleteLocalFile);
  }

  /**
   * Shows Webstrates webstrate preview.
   */
  private webstratePreview() {
    // let uri = vscode.window.activeTextEditor.document.uri;
    let uri = this.previewUri;
    WebstratesEditor.Log.debug('Preview Uri ' + uri);

    let textDocument = vscode.window.activeTextEditor.document;

    this.client.getFileDocument(textDocument).then(fileDocument => {

    });

    return vscode.commands.executeCommand('vscode.previewHtml', uri, vscode.ViewColumn.Two, `Webstrate Preview`)
      .then(success => {
      }, (reason) => {
        vscode.window.showErrorMessage(reason);
      });
  }

  /**
   * Saves the webstrate associated with the text document.
   */
  private saveWebstrate(textDocument) {

    const workspacePath = vscode.workspace.rootPath;
    const webstratesConfigFile = path.join(workspacePath, '.webstrates', 'config.json');

    if (textDocument.fileName === webstratesConfigFile) {
      this.connectToServer();
    }
    else {
      // vscode.window.showInformationMessage('save text doc');
      this.client.saveWebstrate(textDocument);
    }
  }

  /**
   * 
   */
  private webstrateIdInput(): Thenable<string> {
    let workspacePath = vscode.workspace.rootPath;
    return vscode.window.showInputBox({ prompt: 'webstrate id' });
  }

  /**
   * tbd.
   * 
   * @static
   * @param {string} status
   * 
   * @memberOf WebstratesEditor
   */
  public static SetClientStatus(status: string, countdownTime: number = 0) {
    const item = WebstratesEditor.ClientStatusBarItem;

    // Stop any running timer.
    if (WebstratesEditor.timer) {
      WebstratesEditor.timer.dispose();
      WebstratesEditor.timer = undefined;
    }

    const timer = WebstratesEditor.timer = new Timer(countdownTime);
    timer.onElapsed(() => {
      item.text = status;
    });

    if (countdownTime > 0) {
      timer.onTick(({duration}) => {
        item.text = `${status}... ${duration / 1000}s`;
      });
    }

    timer.start();
  }

  public static SetStatus(status: string, spinTimeout: number = 0, tooltip: string = null, color: string = null) {
    const item = WebstratesEditor.StatusBarItem;

    // Stop any running timer.
    if (WebstratesEditor.spinnerTimer) {
      WebstratesEditor.spinnerTimer.dispose();
      WebstratesEditor.spinnerTimer = undefined;
    }

    const spinnerTimer = WebstratesEditor.spinnerTimer = new Timer(spinTimeout, 100);

    spinnerTimer.onTick(() => {
      item.text = `${frame()} ${status}`;
    });

    spinnerTimer.onElapsed(() => {
      item.text = status;
    });

    spinnerTimer.start();

    // if (tooltip) {
    //   WebstratesEditor.StatusBarItem.tooltip = tooltip;
    // }

    // if (color) {
    //   WebstratesEditor.StatusBarItem.color = color;
    // }
  }

  /**
   * 
   */
  public dispose() {
    if (this.client) {

      const config = Utils.loadWorkspaceConfig();
      // const deleteLocalFile = typeof config.deleteLocalFilesOnClose === "undefined" ? true : config.deleteLocalFilesOnClose;
      const deleteLocalFile = !!config.deleteLocalFilesOnClose;

      this.client.dispose(deleteLocalFile);
      this.client = null;
    }
  }
}
