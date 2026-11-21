/**
 * The typed IPC bridge — the renderer's entire view of the outside world.
 *
 * Exposes exactly one object on `window`, named by APP_BRIDGE, implementing AppApi (src/shared/ipc.ts).
 * Main passes the name as a command-line switch (BRIDGE_ARG), because this file cannot import it.
 * No Node APIs and no ipcRenderer are exposed (SPEC.md §2). The one push channel is reached through
 * `onTaskNotice`, which hands the listener the payload only (never the IPC event) and returns an
 * unsubscribe function.
 *
 * This file must stay self-contained: the renderer runs sandboxed (webPreferences.sandbox = true),
 * and a sandboxed preload can only `require` electron and a few builtins — not our own modules.
 * So the channel names are repeated here rather than imported, and `satisfies typeof IPC` (a
 * type-only import, erased at runtime) makes the compiler reject any drift from the contract.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type { BRIDGE_ARG as BridgeArg } from '../shared/app-config';
import type { AppApi, CreateTaskRequest, IPC, TaskAction, TaskNoticeMessage } from '../shared/ipc';
import type { Settings, ThemeSetting } from '../shared/settings';

const CHANNELS = {
  appInfo: 'app:info',
  appSetTheme: 'app:set-theme',
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  claudeAutoDetect: 'claude:auto-detect',
  claudeTestConnection: 'claude:test-connection',
  dialogPickDirectory: 'dialog:pick-directory',
  dialogPickFile: 'dialog:pick-file',
  shellOpenPath: 'shell:open-path',
  shellOpenExternal: 'shell:open-external',
  clipboardWrite: 'clipboard:write',
  tasksList: 'tasks:list',
  tasksGet: 'tasks:get',
  tasksActivity: 'tasks:activity',
  tasksCreate: 'tasks:create',
  tasksAction: 'tasks:action',
  tasksDelete: 'tasks:delete',
  attachmentsPick: 'attachments:pick',
  attachmentsPreview: 'attachments:preview',
  attachmentsOpen: 'attachments:open',
  accountStatus: 'account:status',
  tasksChangedFiles: 'tasks:changed-files',
  tasksOpenFile: 'tasks:open-file',
  projectInspect: 'project:inspect',
  editorCheck: 'editor:check',
  claudeCodeCheck: 'claude-code:check',
  claudeCodeUpdate: 'claude-code:update',
  claudeCodeUpdateOutput: 'claude-code:update-output',
  appUpdateCheck: 'app-update:check',
  usageGet: 'usage:get',
  videoInstallPlan: 'video:install-plan',
  videoReview: 'video:review',
  videoImage: 'video:image',
  videoOpen: 'video:open',
  tasksNotice: 'tasks:notice',
} as const satisfies typeof IPC;

const BRIDGE_ARG = '--app-bridge=' satisfies typeof BridgeArg;

const api: AppApi = {
  getAppInfo: () => ipcRenderer.invoke(CHANNELS.appInfo),
  setTheme: (theme: ThemeSetting) => ipcRenderer.invoke(CHANNELS.appSetTheme, theme),
  getSettings: () => ipcRenderer.invoke(CHANNELS.settingsGet),
  saveSettings: (settings: Settings) => ipcRenderer.invoke(CHANNELS.settingsSave, settings),
  autoDetectClaude: () => ipcRenderer.invoke(CHANNELS.claudeAutoDetect),
  testConnection: (binaryPathOverride?: string | null) =>
    ipcRenderer.invoke(CHANNELS.claudeTestConnection, binaryPathOverride ?? null),
  pickDirectory: (title: string, defaultPath?: string) =>
    ipcRenderer.invoke(CHANNELS.dialogPickDirectory, title, defaultPath),
  pickFile: (title: string, defaultPath?: string) => ipcRenderer.invoke(CHANNELS.dialogPickFile, title, defaultPath),
  openPath: (target: string) => ipcRenderer.invoke(CHANNELS.shellOpenPath, target),
  pickAttachments: () => ipcRenderer.invoke(CHANNELS.attachmentsPick),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  attachmentPreview: (taskId: string, file: string) => ipcRenderer.invoke(CHANNELS.attachmentsPreview, taskId, file),
  openAttachment: (taskId: string, file: string) => ipcRenderer.invoke(CHANNELS.attachmentsOpen, taskId, file),
  openExternal: (url: string) => ipcRenderer.invoke(CHANNELS.shellOpenExternal, url),
  copyText: (text: string) => ipcRenderer.invoke(CHANNELS.clipboardWrite, text),
  listTasks: () => ipcRenderer.invoke(CHANNELS.tasksList),
  getTask: (taskId: string) => ipcRenderer.invoke(CHANNELS.tasksGet, taskId),
  getTurnActivity: (taskId: string, turnId: string) => ipcRenderer.invoke(CHANNELS.tasksActivity, taskId, turnId),
  createTask: (request: CreateTaskRequest) => ipcRenderer.invoke(CHANNELS.tasksCreate, request),
  taskAction: (taskId: string, action: TaskAction) => ipcRenderer.invoke(CHANNELS.tasksAction, taskId, action),
  deleteTask: (taskId: string) => ipcRenderer.invoke(CHANNELS.tasksDelete, taskId),
  getAccountStatus: () => ipcRenderer.invoke(CHANNELS.accountStatus),
  getChangedFiles: (taskId: string) => ipcRenderer.invoke(CHANNELS.tasksChangedFiles, taskId),
  openTaskFile: (taskId: string, relativePath: string) => ipcRenderer.invoke(CHANNELS.tasksOpenFile, taskId, relativePath),
  inspectProject: (dir: string) => ipcRenderer.invoke(CHANNELS.projectInspect, dir),
  videoInstallPlan: (dir: string) => ipcRenderer.invoke(CHANNELS.videoInstallPlan, dir),
  getVideoReview: (taskId: string) => ipcRenderer.invoke(CHANNELS.videoReview, taskId),
  getVideoImage: (taskId: string, name: string, full: boolean) => ipcRenderer.invoke(CHANNELS.videoImage, taskId, name, full === true),
  openVideoOutput: (taskId: string, what: 'folder' | 'video' | 'gif') => ipcRenderer.invoke(CHANNELS.videoOpen, taskId, what),
  checkEditor: (command: string) => ipcRenderer.invoke(CHANNELS.editorCheck, command),
  checkClaudeCode: () => ipcRenderer.invoke(CHANNELS.claudeCodeCheck),
  updateClaudeCode: () => ipcRenderer.invoke(CHANNELS.claudeCodeUpdate),
  checkAppUpdate: (automatic: boolean) => ipcRenderer.invoke(CHANNELS.appUpdateCheck, automatic),
  onClaudeCodeUpdateOutput: (listener: (chunk: string) => void) => {
    const handler = (_event: unknown, chunk: unknown) => {
      if (typeof chunk === 'string') listener(chunk);
    };
    ipcRenderer.on(CHANNELS.claudeCodeUpdateOutput, handler);
    return () => ipcRenderer.removeListener(CHANNELS.claudeCodeUpdateOutput, handler);
  },
  getUsage: (refresh: boolean) => ipcRenderer.invoke(CHANNELS.usageGet, refresh === true),
  onTaskNotice: (listener: (notice: TaskNoticeMessage) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, notice: TaskNoticeMessage) => listener(notice);
    ipcRenderer.on(CHANNELS.tasksNotice, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.tasksNotice, handler);
    };
  },
};

const bridge = process.argv.find((arg) => arg.startsWith(BRIDGE_ARG))?.slice(BRIDGE_ARG.length);
if (!bridge) {
  // The renderer then reports the missing bridge; this line explains why in the console.
  throw new Error(`The preload script was started without ${BRIDGE_ARG}<name>, so the IPC bridge is not exposed.`);
}
contextBridge.exposeInMainWorld(bridge, api);
