import type {
  DesktopBridge,
  DesktopPreviewPointerEvent,
  DesktopPreviewRecordingInputEvent,
  DesktopPreviewRecordingFrame,
  DesktopPreviewTabState,
  DesktopSnapShotEvent,
  DesktopThreadNotificationTarget,
} from "@specweave-studio/contracts";
import { exposeClerkBridge } from "@clerk/electron/preload";
import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";

import * as IpcChannels from "./ipc/channels.ts";
import { mergeLegacyLocalStorage } from "./legacyLocalStorageMerge.ts";

const SNAP_SHOT_EVENT_TYPES = new Set([
  "requested",
  "started",
  "ready",
  "failed",
  "shortcut-changed",
]);
function isSnapShotEvent(value: unknown): value is DesktopSnapShotEvent {
  if (typeof value !== "object" || value === null) return false;
  const { type, id } = value as { type?: unknown; id?: unknown };
  return (
    typeof type === "string" &&
    SNAP_SHOT_EVENT_TYPES.has(type) &&
    (id === undefined || typeof id === "string")
  );
}

exposeClerkBridge({ passkeys: true });

// Runs before any app script reads localStorage. See DesktopLegacyLocalStorage.
try {
  const legacyItems: unknown = ipcRenderer.sendSync(IpcChannels.TAKE_LEGACY_LOCAL_STORAGE_CHANNEL);
  if (typeof legacyItems === "object" && legacyItems !== null) {
    if (mergeLegacyLocalStorage(window.localStorage, legacyItems as Record<string, string>)) {
      void ipcRenderer.invoke(IpcChannels.COMPLETE_LEGACY_LOCAL_STORAGE_CHANNEL);
    }
  }
} catch {
  // Best effort: the app still starts on the V2 profile's own storage.
}

// oxlint-disable-next-line studio/no-global-process-runtime -- Electron exposes the client platform in its sandboxed preload process.
const clientPlatform = process.platform;
// Set by the shell when it creates the window (DESKTOP_WINDOW_ROLE_ARGUMENT).
const windowRole = process.argv.includes("--studio-window-role=project") ? "project" : "main";
// The project a project window was opened for (DESKTOP_WINDOW_PROJECT_ARGUMENT).
const WINDOW_PROJECT_ARGUMENT = "--studio-window-project=";
const windowProjectKey = (() => {
  const argument = process.argv.find((value) => value.startsWith(WINDOW_PROJECT_ARGUMENT));
  if (argument === undefined) return null;
  try {
    return decodeURIComponent(argument.slice(WINDOW_PROJECT_ARGUMENT.length)) || null;
  } catch {
    return null;
  }
})();

if (clientPlatform === "darwin") {
  // Native window buttons do not scale with Chromium zoom. Keep their reserved
  // space in native points, including when a zoomed page is reloaded.
  const syncWindowControlInset = () => {
    document.documentElement.style.setProperty(
      "--desktop-window-controls-inset",
      `${90 / webFrame.getZoomFactor()}px`,
    );
  };
  window.addEventListener("DOMContentLoaded", syncWindowControlInset, { once: true });
  window.addEventListener("resize", syncWindowControlInset);
}

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
}

// Clicked thread notifications. The shell holds a click until a window takes
// it; this document asks once it loads and again whenever the shell says one
// is waiting, and keeps it until the thread notification coordinator listens.
const threadOpenListeners = new Set<(target: DesktopThreadNotificationTarget) => void>();
let bufferedThreadOpen: { target: DesktopThreadNotificationTarget; at: number } | null = null;
// Matches how long the shell holds a click; an older one would open a thread
// the user has long moved on from.
const BUFFERED_THREAD_OPEN_TTL_MS = 60_000;
function takeThreadNotificationOpen() {
  void ipcRenderer.invoke(IpcChannels.TAKE_THREAD_NOTIFICATION_OPEN_CHANNEL).then(
    (target: unknown) => {
      if (typeof target !== "object" || target === null) return;
      const { environmentId, threadId } = target as { environmentId?: unknown; threadId?: unknown };
      if (typeof environmentId !== "string" || typeof threadId !== "string") return;
      const open = { environmentId, threadId };
      if (threadOpenListeners.size === 0) {
        bufferedThreadOpen = { target: open, at: Date.now() };
        return;
      }
      for (const listener of threadOpenListeners) listener(open);
    },
    () => undefined,
  );
}
ipcRenderer.on(IpcChannels.THREAD_NOTIFICATION_OPEN_CHANNEL, takeThreadNotificationOpen);
takeThreadNotificationOpen();

contextBridge.exposeInMainWorld("desktopBridge", {
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppBranding"]>;
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getClientPlatform: () => clientPlatform,
  getWindowRole: () => windowRole,
  getWindowProjectKey: () => windowProjectKey,
  setNotificationBadge: (badge) =>
    ipcRenderer.invoke(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, badge),
  setKeepAwake: (state) => ipcRenderer.invoke(IpcChannels.SET_KEEP_AWAKE_CHANNEL, state),
  getVoiceStatus: () => ipcRenderer.invoke(IpcChannels.VOICE_GET_STATUS_CHANNEL),
  requestVoiceAccess: () => ipcRenderer.invoke(IpcChannels.VOICE_REQUEST_ACCESS_CHANNEL),
  setVoiceCallActive: (state) =>
    ipcRenderer.invoke(IpcChannels.VOICE_SET_CALL_ACTIVE_CHANNEL, state),
  transcribeVoice: async (input) => {
    const result = await ipcRenderer.invoke(IpcChannels.VOICE_TRANSCRIBE_CHANNEL, input);
    if (result?.ok !== true) throw new Error(result?.error ?? "Could not transcribe.");
    return result.text;
  },
  synthesizeVoice: async (input) => {
    const result = await ipcRenderer.invoke(IpcChannels.VOICE_SYNTHESIZE_CHANNEL, input);
    if (result?.ok !== true) throw new Error(result?.error ?? "Could not read the reply aloud.");
    return result.audio;
  },
  openMicrophoneSettings: () =>
    ipcRenderer.invoke(IpcChannels.VOICE_OPEN_MICROPHONE_SETTINGS_CHANNEL),
  getNotificationOwner: () =>
    ipcRenderer.sendSync(IpcChannels.GET_NOTIFICATION_OWNER_CHANNEL) !== false,
  onNotificationOwnerChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, owner: unknown) => {
      if (typeof owner !== "boolean") return;
      listener(owner);
    };
    ipcRenderer.on(IpcChannels.NOTIFICATION_OWNER_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.NOTIFICATION_OWNER_CHANNEL, handler);
  },
  showThreadNotification: async (input) =>
    (await ipcRenderer.invoke(IpcChannels.SHOW_THREAD_NOTIFICATION_CHANNEL, input)) === true,
  closeThreadNotification: async (tag) => {
    await ipcRenderer.invoke(IpcChannels.CLOSE_THREAD_NOTIFICATION_CHANNEL, tag);
  },
  onThreadNotificationOpen: (listener) => {
    threadOpenListeners.add(listener);
    // A click that came in before anything listened, for example while the
    // window was still loading.
    const buffered = bufferedThreadOpen;
    bufferedThreadOpen = null;
    if (buffered && Date.now() - buffered.at <= BUFFERED_THREAD_OPEN_TTL_MS) {
      listener(buffered.target);
    }
    return () => {
      threadOpenListeners.delete(listener);
    };
  },
  openProjectWindow: (input) => ipcRenderer.invoke(IpcChannels.OPEN_PROJECT_WINDOW_CHANNEL, input),
  onNotificationBadgeClear: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.SET_NOTIFICATION_BADGE_CHANNEL, handler);
  },
  onTrackpadScrollEnd: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.TRACKPAD_SCROLL_END_CHANNEL, handler);
  },
  getSystemLocale: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_SYSTEM_LOCALE_CHANNEL);
    return typeof result === "string" ? result : null;
  },
  getLocalEnvironmentBootstraps: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL);
    if (!Array.isArray(result)) {
      return [];
    }
    return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstraps"]>;
  },
  getLocalEnvironmentBearerToken: () =>
    ipcRenderer.invoke(IpcChannels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL),
  getLocalEnvironmentEnabled: () =>
    ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL) !== false,
  setLocalEnvironmentEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL, enabled),
  getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) =>
    ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  onClientSettingsChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, settings: unknown) => {
      if (typeof settings !== "object" || settings === null) return;
      listener(settings as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IpcChannels.CLIENT_SETTINGS_CHANGED_CHANNEL, handler);
  },
  requestSnapShotPermissions: (includeAccessibility) =>
    ipcRenderer.invoke(IpcChannels.REQUEST_SNAP_SHOT_PERMISSIONS_CHANNEL, includeAccessibility),
  getSnapShotState: () => ipcRenderer.invoke(IpcChannels.GET_SNAP_SHOT_STATE_CHANNEL),
  setupSnapShot: (action) => ipcRenderer.invoke(IpcChannels.SETUP_SNAP_SHOT_CHANNEL, action),
  previewSnapShotConfig: (request) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_SNAP_SHOT_CONFIG_CHANNEL, request),
  applySnapShotConfig: (id) => ipcRenderer.invoke(IpcChannels.APPLY_SNAP_SHOT_CONFIG_CHANNEL, id),
  checkSnapShotShortcut: (shortcut) =>
    ipcRenderer.invoke(IpcChannels.CHECK_SNAP_SHOT_SHORTCUT_CHANNEL, shortcut),
  setSnapShotShortcutSuppressed: (suppressed) =>
    ipcRenderer.invoke(IpcChannels.SET_SNAP_SHOT_SHORTCUT_SUPPRESSED_CHANNEL, suppressed),
  listPendingSnapShots: () => ipcRenderer.invoke(IpcChannels.LIST_PENDING_SNAP_SHOTS_CHANNEL),
  readSnapShot: (id) => ipcRenderer.invoke(IpcChannels.READ_SNAP_SHOT_CHANNEL, id),
  setSnapShotAnimationDestination: (destination) =>
    ipcRenderer.invoke(IpcChannels.SET_SNAP_SHOT_ANIMATION_DESTINATION_CHANNEL, destination),
  dismissSnapShotAnimation: (id) =>
    ipcRenderer.invoke(IpcChannels.DISMISS_SNAP_SHOT_ANIMATION_CHANNEL, id),
  acknowledgeSnapShot: (id) => ipcRenderer.invoke(IpcChannels.ACKNOWLEDGE_SNAP_SHOT_CHANNEL, id),
  getConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.GET_CONNECTION_CATALOG_CHANNEL),
  setConnectionCatalog: (catalog) =>
    ipcRenderer.invoke(IpcChannels.SET_CONNECTION_CATALOG_CHANNEL, catalog),
  clearConnectionCatalog: () => ipcRenderer.invoke(IpcChannels.CLEAR_CONNECTION_CATALOG_CHANNEL),
  discoverSshHosts: () => ipcRenderer.invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL),
  resolveSshHost: (alias) => ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_HOST_CHANNEL, alias),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await ipcRenderer.invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
        target,
        ...(options === undefined ? {} : { options }),
      }),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, { httpBaseUrl }),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
      httpBaseUrl,
      credential,
    }),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, { httpBaseUrl, bearerToken }),
  issueSshWebSocketTicket: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL, { httpBaseUrl, bearerToken }),
  onSshPasswordPrompt: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    };
  },
  resolveSshPasswordPrompt: (requestId, password) =>
    ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, { requestId, password }),
  getServerExposureState: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) =>
    ipcRenderer.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  setTailscaleServeEnabled: (input) =>
    ipcRenderer.invoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
  checkTailscaleHttps: () => ipcRenderer.invoke(IpcChannels.CHECK_TAILSCALE_HTTPS_CHANNEL),
  getWslState: () => ipcRenderer.invoke(IpcChannels.GET_WSL_STATE_CHANNEL),
  setWslBackendEnabled: (enabled) =>
    ipcRenderer.invoke(IpcChannels.SET_WSL_BACKEND_ENABLED_CHANNEL, enabled),
  setWslDistro: (distro) => ipcRenderer.invoke(IpcChannels.SET_WSL_DISTRO_CHANNEL, distro),
  setWslOnly: (enabled) => ipcRenderer.invoke(IpcChannels.SET_WSL_ONLY_CHANNEL, enabled),
  pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  pickProjectFavicon: (initialPath) =>
    ipcRenderer.invoke(IpcChannels.PICK_PROJECT_FAVICON_CHANNEL, initialPath),
  pickThemeFiles: () => ipcRenderer.invoke(IpcChannels.PICK_THEME_FILES_CHANNEL, undefined),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) =>
    ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),
  receiveProviderAuthCallback: (url: string) =>
    ipcRenderer.invoke(IpcChannels.RECEIVE_PROVIDER_AUTH_CALLBACK_CHANNEL, url),
  cancelProviderAuthCallback: (url: string) =>
    ipcRenderer.invoke(IpcChannels.CANCEL_PROVIDER_AUTH_CALLBACK_CHANNEL, url),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  listExternalBrowsers: () =>
    ipcRenderer.invoke(IpcChannels.LIST_EXTERNAL_BROWSERS_CHANNEL, undefined),
  openInExternalBrowser: (input) =>
    ipcRenderer.invoke(IpcChannels.OPEN_IN_EXTERNAL_BROWSER_CHANNEL, input),
  checkSystemPermission: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.CHECK_SYSTEM_PERMISSION_CHANNEL, pane),
  openSystemSettings: (pane: string) =>
    ipcRenderer.invoke(IpcChannels.OPEN_SYSTEM_SETTINGS_CHANNEL, pane),
  probeRemoteEditors: () => ipcRenderer.invoke(IpcChannels.PROBE_REMOTE_EDITORS_CHANNEL, undefined),
  pasteAsText: () => ipcRenderer.invoke(IpcChannels.PASTE_AS_TEXT_CHANNEL, undefined),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  onSnapShotEvent: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
      if (!isSnapShotEvent(event)) return;
      listener(event);
    };

    ipcRenderer.on(IpcChannels.SNAP_SHOT_EVENT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SNAP_SHOT_EVENT_CHANNEL, wrappedListener);
    };
  },
  onQuitShortcut: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, hint: unknown) => {
      if (typeof hint !== "object" || hint === null || !("state" in hint)) return;
      if (hint.state === "up") {
        listener({ state: "up" });
        return;
      }
      if (
        hint.state === "down" &&
        "mode" in hint &&
        (hint.mode === "hold" || hint.mode === "double-click")
      ) {
        listener({ state: "down", mode: hint.mode });
      }
    };

    ipcRenderer.on(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.QUIT_SHORTCUT_CHANNEL, wrappedListener);
    };
  },
  getWindowFullscreenState: () =>
    ipcRenderer.sendSync(IpcChannels.GET_WINDOW_FULLSCREEN_STATE_CHANNEL) === true,
  onWindowFullscreenStateChange: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, fullscreen: unknown) => {
      if (typeof fullscreen !== "boolean") return;
      listener(fullscreen);
    };

    ipcRenderer.on(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.WINDOW_FULLSCREEN_STATE_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, channel),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: (options) => ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL, options),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  getUpdatePreferences: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_PREFERENCES_CHANNEL),
  setUpdatePreferences: (patch) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SET_PREFERENCES_CHANNEL, patch),
  getServiceUpdateState: () => ipcRenderer.invoke(IpcChannels.SERVICE_UPDATE_GET_STATE_CHANNEL),
  checkServiceUpdate: () => ipcRenderer.invoke(IpcChannels.SERVICE_UPDATE_CHECK_CHANNEL),
  installServiceUpdate: (options) =>
    ipcRenderer.invoke(IpcChannels.SERVICE_UPDATE_INSTALL_CHANNEL, options),
  cancelServiceUpdate: () => ipcRenderer.invoke(IpcChannels.SERVICE_UPDATE_CANCEL_CHANNEL),
  onServiceUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.SERVICE_UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SERVICE_UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
  appActivation: {
    setReady: (ready) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL, ready),
    complete: (response) =>
      ipcRenderer.invoke(IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL, response),
    onRequest: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
        if (typeof request !== "object" || request === null) return;
        listener(request as Parameters<typeof listener>[0]);
      };
      ipcRenderer.on(IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, wrappedListener);
      return () => {
        ipcRenderer.removeListener(
          IpcChannels.DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL,
          wrappedListener,
        );
      };
    },
  },
  preview: {
    setForwardedShortcuts: (shortcuts) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_FORWARDED_SHORTCUTS_CHANNEL, shortcuts),
    createTab: (tabId, defaults) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CREATE_TAB_CHANNEL, {
        tabId,
        zoomFactor: defaults?.zoomFactor,
        serverTab: defaults?.serverTab,
        colorScheme: defaults?.colorScheme,
      }),
    closeTab: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_CLOSE_TAB_CHANNEL, { tabId }),
    registerWebview: (tabId, webContentsId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REGISTER_WEBVIEW_CHANNEL, { tabId, webContentsId }),
    navigate: (tabId, url) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_NAVIGATE_CHANNEL, { tabId, url }),
    goBack: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_BACK_CHANNEL, { tabId }),
    goForward: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_GO_FORWARD_CHANNEL, { tabId }),
    refresh: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_REFRESH_CHANNEL, { tabId }),
    zoomIn: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_IN_CHANNEL, { tabId }),
    zoomOut: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_ZOOM_OUT_CHANNEL, { tabId }),
    resetZoom: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_RESET_ZOOM_CHANNEL, { tabId }),
    setZoomFactor: (tabId, zoomFactor) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ZOOM_FACTOR_CHANNEL, { tabId, zoomFactor }),
    hardReload: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_HARD_RELOAD_CHANNEL, { tabId }),
    setColorScheme: (tabId, colorScheme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, { tabId, colorScheme }),
    setAudioMuted: (tabId, audioMuted) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_AUDIO_MUTED_CHANNEL, { tabId, audioMuted }),
    openDevTools: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, { tabId }),
    listBrowserImportSources: () => ipcRenderer.invoke(IpcChannels.PREVIEW_IMPORT_SOURCES_CHANNEL),
    importBrowserCookies: (input) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_IMPORT_COOKIES_CHANNEL, input),
    clearCookies: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_COOKIES_CHANNEL, { environmentId, profileId }),
    clearCache: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL, { environmentId, profileId }),
    getPreviewConfig: (environmentId, profileId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_GET_CONFIG_CHANNEL, { environmentId, profileId }),
    setAnnotationTheme: (theme) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_THEME_CHANNEL, { theme }),
    setAnnotationSendEnabled: (tabId, enabled) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_SEND_ENABLED_CHANNEL, {
        tabId,
        enabled,
      }),
    pickElement: (tabId) => ipcRenderer.invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, { tabId }),
    cancelPickElement: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CANCEL_PICK_ELEMENT_CHANNEL, { tabId }),
    captureScreenshot: (tabId) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_CAPTURE_SCREENSHOT_CHANNEL, { tabId }),
    revealArtifact: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_REVEAL_ARTIFACT_CHANNEL, { path }),
    copyArtifactToClipboard: (path) =>
      ipcRenderer.invoke(IpcChannels.PREVIEW_COPY_ARTIFACT_CHANNEL, { path }),
    pictureInPicture: {
      open: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_OPEN_CHANNEL, { tabId }),
      close: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_PICTURE_IN_PICTURE_CLOSE_CHANNEL, { tabId }),
    },
    recording: {
      onInput: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, event: unknown) => {
          if (typeof event !== "object" || event === null) return;
          listener(event as DesktopPreviewRecordingInputEvent);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(IpcChannels.PREVIEW_RECORDING_INPUT_CHANNEL, wrappedListener);
      },
      startScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_START_CHANNEL, { tabId }),
      stopScreencast: (tabId) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_STOP_CHANNEL, { tabId }),
      save: (tabId, mimeType, data) =>
        ipcRenderer.invoke(IpcChannels.PREVIEW_RECORDING_SAVE_CHANNEL, {
          tabId,
          mimeType,
          data,
        }),
      onFrame: (listener) => {
        const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
          if (typeof frame !== "object" || frame === null) return;
          listener(frame as DesktopPreviewRecordingFrame);
        };
        ipcRenderer.on(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
        return () =>
          ipcRenderer.removeListener(IpcChannels.PREVIEW_RECORDING_FRAME_CHANNEL, wrappedListener);
      },
    },
    onStateChange: (listener) => {
      const wrappedListener = (
        _event: Electron.IpcRendererEvent,
        tabId: unknown,
        state: unknown,
      ) => {
        if (typeof tabId !== "string" || typeof state !== "object" || state === null) return;
        listener(tabId, state as DesktopPreviewTabState);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_STATE_CHANGE_CHANNEL, wrappedListener);
    },
    onPointerEvent: (listener) => {
      const wrappedListener = (_event: Electron.IpcRendererEvent, pointerEvent: unknown) => {
        if (typeof pointerEvent !== "object" || pointerEvent === null) return;
        listener(pointerEvent as DesktopPreviewPointerEvent);
      };
      ipcRenderer.on(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
      return () =>
        ipcRenderer.removeListener(IpcChannels.PREVIEW_POINTER_EVENT_CHANNEL, wrappedListener);
    },
  },
} satisfies DesktopBridge);
