import { Errors } from "isomorphic-git";
import type { Debouncer, Menu, TAbstractFile, WorkspaceLeaf } from "obsidian";
import {
    debounce,
    FileSystemAdapter,
    MarkdownView,
    Modal,
    normalizePath,
    Notice,
    Platform,
    Plugin,
    requestUrl,
    TFile,
    TFolder,
    moment,
} from "obsidian";
import * as path from "path";
import { pluginRef } from "src/pluginGlobalRef";
import { PromiseQueue } from "src/promiseQueue";
import { ObsidianGitSettingsTab } from "src/setting/settings";
import { StatusBar } from "src/statusBar";
import { CustomMessageModal } from "src/ui/modals/customMessageModal";
import AutomaticsManager from "./automaticsManager";
import { addCommmands } from "./commands";
import {
    CONFLICT_OUTPUT_FILE,
    DEFAULT_SETTINGS,
    DEPLOYER_EMAIL,
    DIFF_VIEW_CONFIG,
    HISTORY_VIEW_CONFIG,
    PLUGIN_BLOCK_RATE_LIMIT_MS,
    PLUGIN_PATH_PREFIX,
    SOURCE_CONTROL_VIEW_CONFIG,
    SPLIT_DIFF_VIEW_CONFIG,
} from "./constants";
import type { GitManager } from "./gitManager/gitManager";
import { IsomorphicGit } from "./gitManager/isomorphicGit";
import { SimpleGit } from "./gitManager/simpleGit";
import { LocalStorageSettings } from "./setting/localStorageSettings";
import Tools from "./tools";
import type {
    FileStatusResult,
    ObsidianGitSettings,
    PluginState,
    Status,
    UnstagedFile,
} from "./types";
import {
    CurrentGitAction,
    mergeSettingsByPriority,
    NoNetworkError,
} from "./types";
import DiffView from "./ui/diff/diffView";
import SplitDiffView from "./ui/diff/splitDiffView";
import HistoryView from "./ui/history/historyView";
import { BranchModal } from "./ui/modals/branchModal";
import { GeneralModal } from "./ui/modals/generalModal";
import GitView from "./ui/sourceControl/sourceControl";
import { BranchStatusBar } from "./ui/statusBar/branchStatusBar";
import {
    assertNever,
    convertPathToAbsoluteGitignoreRule,
    formatRemoteUrl,
    spawnAsync,
    splitRemoteBranch,
} from "./utils";
import { DiscardModal, type DiscardResult } from "./ui/modals/discardModal";
import { HunkActions } from "./editor/signs/hunkActions";
import { EditorIntegration } from "./editor/editorIntegration";

// ============================================================================
// 05번 설계 문서: Obsidian-Git auto-commit 사전검사 설계
// Source of truth: pi-knowledge-base/02_개인/이한덕/Obsidian-Git 이슈/05_*.md
// ============================================================================

/**
 * autostash 식별용 stash 메시지 prefix.
 * 03번 stash push 호출과 05번 _preflightCheck 검사 1-A가 동일 상수를
 * substring 매칭으로 사용한다. 정규식 금지, 하이픈 변형 금지.
 */
const OBSIDIAN_GIT_AUTOSTASH_TAG = "obsidian-git autostash";

/**
 * Captain Hook 알림 설정은 **data.json 우선, localStorage 폴백** 순서로 읽는다.
 *
 * - data.json (`captainHookWebhookUrl`, `captainHookMentionId`): git 추적 → 팀 전체 전파.
 *   2026-04-22 Option-1 배포. 20명 PC에 동일 webhook이 자동 배포되도록 함.
 * - localStorage (`obsidian-git:captainHookWebhookUrl` 등): PC별 개별 설정.
 *   이전(9d19554) 호환을 위해 폴백으로 유지. data.json이 비어 있을 때만 사용.
 *
 * 둘 다 비어 있으면 Discord 알림 silent skip, Modal 알림은 그대로 발사.
 *
 * data.json 수정 방법 (추천):
 *   .obsidian/plugins/obsidian-git/data.json 파일에 아래 2개 키 추가:
 *     "captainHookWebhookUrl": "https://discord.com/api/webhooks/..."
 *     "captainHookMentionId": "1480357717288681473"
 *
 * localStorage 폴백 방법 (devtools console):
 *   app.saveLocalStorage("obsidian-git:captainHookWebhookUrl", "...")
 *   app.saveLocalStorage("obsidian-git:captainHookMentionId", "...")
 */
function getCaptainHookConfig(plugin: {
    app: ObsidianGit["app"];
    settings: ObsidianGit["settings"];
}): { webhookUrl: string | null; mentionId: string | null } {
    const settingsUrl = plugin.settings.captainHookWebhookUrl?.trim() || null;
    const settingsMention = plugin.settings.captainHookMentionId?.trim() || null;
    const lsUrl =
        plugin.app.loadLocalStorage(
            "obsidian-git:captainHookWebhookUrl"
        ) ?? null;
    const lsMention =
        plugin.app.loadLocalStorage(
            "obsidian-git:captainHookMentionId"
        ) ?? null;
    return {
        webhookUrl: settingsUrl || lsUrl,
        mentionId: settingsMention || lsMention,
    };
}

/**
 * mass-delete 임계치. Phase 0과 Phase 0.5에서 동일 값 사용.
 */
const MASS_DELETE_THRESHOLD = 30;

/**
 * Modal 자동 닫힘 시간 (ms). 확인 버튼 없이 10초 후 자동 close.
 */
const MODAL_AUTO_CLOSE_MS = 10000;

/**
 * 사전검사 danger 정보 타입.
 */
interface PreflightDanger {
    prefix: string;
    detail: string;
}

/**
 * 사전검사 경고용 Obsidian Modal.
 * - 확인 버튼 없음
 * - 10초 후 자동 close (setTimeout)
 * - ESC 키 또는 바깥 클릭으로 즉시 close (Obsidian 기본 동작)
 */
class PreflightWarningModal extends Modal {
    private prefix: string;
    private detail: string;
    private autoCloseTimer: number | null = null;

    constructor(app: ObsidianGit["app"], prefix: string, detail: string) {
        super(app);
        this.prefix = prefix;
        this.detail = detail;
    }

    onOpen(): void {
        const { contentEl, titleEl } = this;
        titleEl.setText(this.prefix);
        contentEl.empty();
        contentEl.createEl("p", { text: this.detail });
        contentEl.createEl("p", {
            text: "auto-commit 사이클이 스킵되었습니다. 즉시 이한덕에게 문의하세요.",
        });
        contentEl.createEl("p", {
            text: "auto-pull은 영향 없이 정상 동작합니다. 정리 전까지 10분마다 이 알림이 반복됩니다.",
            attr: {
                style: "color: var(--text-muted); font-size: 0.85em;",
            },
        });
        // 확인 버튼 없음 — 10초 후 자동 닫힘
        this.autoCloseTimer = window.setTimeout(() => {
            this.close();
        }, MODAL_AUTO_CLOSE_MS);
    }

    onClose(): void {
        if (this.autoCloseTimer !== null) {
            window.clearTimeout(this.autoCloseTimer);
            this.autoCloseTimer = null;
        }
        this.contentEl.empty();
    }
}

export default class ObsidianGit extends Plugin {
    gitManager: GitManager;
    automaticsManager = new AutomaticsManager(this);
    tools = new Tools(this);
    localStorage = new LocalStorageSettings(this);
    settings: ObsidianGitSettings;
    settingsTab?: ObsidianGitSettingsTab;
    statusBar?: StatusBar;
    branchBar?: BranchStatusBar;
    state: PluginState = {
        gitAction: CurrentGitAction.idle,
        offlineMode: false,
    };
    lastPulledFiles: FileStatusResult[];
    gitReady = false;
    promiseQueue: PromiseQueue = new PromiseQueue(this);

    /**
     * Debouncer for the auto commit after file changes.
     */
    autoCommitDebouncer: Debouncer<[], void> | undefined;
    cachedStatus: Status | undefined;
    // Used to store the path of the file that is currently shown in the diff view.
    lastDiffViewState: Record<string, unknown> | undefined;
    intervalsToClear: number[] = [];
    editorIntegration: EditorIntegration = new EditorIntegration(this);
    hunkActions = new HunkActions(this);

    /**
     * Debouncer for the refresh of the git status for the source control view after file changes.
     */
    debRefresh: Debouncer<[], void>;

    setPluginState(state: Partial<PluginState>): void {
        this.state = Object.assign(this.state, state);
        this.statusBar?.display();
    }

    async updateCachedStatus(): Promise<Status> {
        this.app.workspace.trigger("obsidian-git:loading-status");
        this.cachedStatus = await this.gitManager.status();
        if (this.cachedStatus.conflicted.length > 0) {
            this.localStorage.setConflict(true);
            await this.branchBar?.display();
        } else {
            this.localStorage.setConflict(false);
            await this.branchBar?.display();
        }

        this.app.workspace.trigger(
            "obsidian-git:status-changed",
            this.cachedStatus
        );
        return this.cachedStatus;
    }

    async refresh() {
        if (!this.gitReady) return;

        const gitViews = this.app.workspace.getLeavesOfType(
            SOURCE_CONTROL_VIEW_CONFIG.type
        );
        const historyViews = this.app.workspace.getLeavesOfType(
            HISTORY_VIEW_CONFIG.type
        );

        if (
            this.settings.changedFilesInStatusBar ||
            gitViews.some((leaf) => !(leaf.isDeferred ?? false)) ||
            historyViews.some((leaf) => !(leaf.isDeferred ?? false))
        ) {
            await this.updateCachedStatus().catch((e) => this.displayError(e));
        }

        this.app.workspace.trigger("obsidian-git:refreshed");

        // We don't put a line authoring refresh here, as it would force a re-loading
        // of the line authoring feature - which would lead to a jumpy editor-view in the
        // ui after every rename event.
    }

    refreshUpdatedHead() {}

    async onload() {
        console.log(
            "loading " +
                this.manifest.name +
                " plugin: v" +
                this.manifest.version
        );

        pluginRef.plugin = this;

        this.localStorage.migrate();
        await this.loadSettings();
        await this.migrateSettings();

        this.settingsTab = new ObsidianGitSettingsTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        if (!this.localStorage.getPluginDisabled()) {
            this.registerStuff();

            this.app.workspace.onLayoutReady(() =>
                this.init({ fromReload: false }).catch((e) =>
                    this.displayError(e)
                )
            );
        }
    }

    onExternalSettingsChange() {
        this.reloadSettings().catch((e) => this.displayError(e));
    }

    /** Reloads the settings from disk and applies them by unloading the plugin
     * and initializing it again.
     */
    async reloadSettings(): Promise<void> {
        const previousSettings = JSON.stringify(this.settings);

        await this.loadSettings();

        const newSettings = JSON.stringify(this.settings);

        // Only reload plugin if the settings have actually changed
        if (previousSettings !== newSettings) {
            this.log("Reloading settings");

            this.unloadPlugin();

            await this.init({ fromReload: true });

            this.app.workspace
                .getLeavesOfType(SOURCE_CONTROL_VIEW_CONFIG.type)
                .forEach((leaf) => {
                    if (!(leaf.isDeferred ?? false))
                        return (leaf.view as GitView).reload();
                });

            this.app.workspace
                .getLeavesOfType(HISTORY_VIEW_CONFIG.type)
                .forEach((leaf) => {
                    if (!(leaf.isDeferred ?? false))
                        return (leaf.view as HistoryView).reload();
                });
        }
    }

    /** This method only registers events, views, commands and more.
     *
     * This only needs to be called once since the registered events are
     * unregistered when the plugin is unloaded.
     *
     * This mustn't depend on the plugin's settings.
     */
    registerStuff(): void {
        this.registerEvent(
            this.app.workspace.on("obsidian-git:refresh", () => {
                this.refresh().catch((e) => this.displayError(e));
            })
        );
        this.registerEvent(
            this.app.workspace.on("obsidian-git:head-change", () => {
                this.refreshUpdatedHead();
            })
        );

        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file, source) => {
                this.handleFileMenu(menu, file, source, "file-manu");
            })
        );

        this.registerEvent(
            this.app.workspace.on("obsidian-git:menu", (menu, path, source) => {
                this.handleFileMenu(menu, path, source, "obsidian-git:menu");
            })
        );

        this.registerEvent(
            this.app.workspace.on("active-leaf-change", (leaf) => {
                this.onActiveLeafChange(leaf);
            })
        );
        this.registerEvent(
            this.app.vault.on("modify", () => {
                this.debRefresh();
                this.autoCommitDebouncer?.();
            })
        );
        this.registerEvent(
            this.app.vault.on("delete", () => {
                this.debRefresh();
                this.autoCommitDebouncer?.();
            })
        );
        this.registerEvent(
            this.app.vault.on("create", () => {
                this.debRefresh();
                this.autoCommitDebouncer?.();
            })
        );
        this.registerEvent(
            this.app.vault.on("rename", () => {
                this.debRefresh();
                this.autoCommitDebouncer?.();
            })
        );

        this.registerView(SOURCE_CONTROL_VIEW_CONFIG.type, (leaf) => {
            return new GitView(leaf, this);
        });

        this.registerView(HISTORY_VIEW_CONFIG.type, (leaf) => {
            return new HistoryView(leaf, this);
        });

        this.registerView(DIFF_VIEW_CONFIG.type, (leaf) => {
            return new DiffView(leaf, this);
        });

        this.registerView(SPLIT_DIFF_VIEW_CONFIG.type, (leaf) => {
            return new SplitDiffView(leaf, this);
        });
        this.addRibbonIcon(
            "git-pull-request",
            "Open Git source control",
            async () => {
                const leafs = this.app.workspace.getLeavesOfType(
                    SOURCE_CONTROL_VIEW_CONFIG.type
                );
                let leaf: WorkspaceLeaf;
                if (leafs.length === 0) {
                    leaf =
                        this.app.workspace.getRightLeaf(false) ??
                        this.app.workspace.getLeaf();
                    await leaf.setViewState({
                        type: SOURCE_CONTROL_VIEW_CONFIG.type,
                    });
                } else {
                    leaf = leafs.first()!;
                }
                await this.app.workspace.revealLeaf(leaf);
            }
        );

        this.registerHoverLinkSource(SOURCE_CONTROL_VIEW_CONFIG.type, {
            display: "Git View",
            defaultMod: true,
        });

        this.editorIntegration.onLoadPlugin();

        this.setRefreshDebouncer();

        addCommmands(this);
    }

    setRefreshDebouncer(): void {
        this.debRefresh?.cancel();
        this.debRefresh = debounce(
            () => {
                if (this.settings.refreshSourceControl) {
                    this.refresh().catch(console.error);
                }
            },
            this.settings.refreshSourceControlTimer,
            true
        );
    }

    async addFileToGitignore(
        filePath: string,
        isFolder?: boolean
    ): Promise<void> {
        const gitRelativePath = this.gitManager.getRelativeRepoPath(
            filePath,
            true
        );
        // Define an absolute rule that can apply only for this item.
        const gitignoreRule = convertPathToAbsoluteGitignoreRule({
            isFolder,
            gitRelativePath,
        });
        await this.app.vault.adapter.append(
            this.gitManager.getRelativeVaultPath(".gitignore"),
            "\n" + gitignoreRule
        );
        this.app.workspace.trigger("obsidian-git:refresh");
    }

    handleFileMenu(
        menu: Menu,
        file: TAbstractFile | string,
        source: string,
        type: "file-manu" | "obsidian-git:menu"
    ): void {
        if (!this.gitReady) return;
        if (!this.settings.showFileMenu) return;
        if (!file) return;
        let filePath: string;
        if (typeof file === "string") {
            filePath = file;
        } else {
            filePath = file.path;
        }

        if (source == "file-explorer-context-menu") {
            menu.addItem((item) => {
                item.setTitle(`Git: Stage`)
                    .setIcon("plus-circle")
                    .setSection("action")
                    .onClick((_) => {
                        this.promiseQueue.addTask(async () => {
                            if (file instanceof TFile) {
                                await this.stageFile(file);
                            } else {
                                await this.gitManager.stageAll({
                                    dir: this.gitManager.getRelativeRepoPath(
                                        filePath,
                                        true
                                    ),
                                });
                                this.app.workspace.trigger(
                                    "obsidian-git:refresh"
                                );
                            }
                        });
                    });
            });
            menu.addItem((item) => {
                item.setTitle(`Git: Unstage`)
                    .setIcon("minus-circle")
                    .setSection("action")
                    .onClick((_) => {
                        this.promiseQueue.addTask(async () => {
                            if (file instanceof TFile) {
                                await this.unstageFile(file);
                            } else {
                                await this.gitManager.unstageAll({
                                    dir: this.gitManager.getRelativeRepoPath(
                                        filePath,
                                        true
                                    ),
                                });

                                this.app.workspace.trigger(
                                    "obsidian-git:refresh"
                                );
                            }
                        });
                    });
            });
            menu.addItem((item) => {
                item.setTitle(`Git: Add to .gitignore`)
                    .setIcon("file-x")
                    .setSection("action")
                    .onClick((_) => {
                        this.addFileToGitignore(
                            filePath,
                            file instanceof TFolder
                        ).catch((e) => this.displayError(e));
                    });
            });
        }

        if (source == "git-source-control") {
            menu.addItem((item) => {
                item.setTitle(`Git: Add to .gitignore`)
                    .setIcon("file-x")
                    .setSection("action")
                    .onClick((_) => {
                        this.addFileToGitignore(
                            filePath,
                            file instanceof TFolder
                        ).catch((e) => this.displayError(e));
                    });
            });
            const gitManager = this.app.vault.adapter;
            if (
                type === "obsidian-git:menu" &&
                gitManager instanceof FileSystemAdapter
            ) {
                menu.addItem((item) => {
                    item.setTitle("Open in default app")
                        .setIcon("arrow-up-right")
                        .setSection("action")
                        .onClick((_) => {
                            this.app.openWithDefaultApp(filePath);
                        });
                });
                menu.addItem((item) => {
                    item.setTitle("Show in system explorer")
                        .setIcon("arrow-up-right")
                        .setSection("action")
                        .onClick((_) => {
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                            (window as any).electron.shell.showItemInFolder(
                                path.join(gitManager.getBasePath(), filePath)
                            );
                        });
                });
            }
        }
    }

    async migrateSettings(): Promise<void> {
        if (this.settings.mergeOnPull != undefined) {
            this.settings.syncMethod = this.settings.mergeOnPull
                ? "merge"
                : "rebase";
            this.settings.mergeOnPull = undefined;
            await this.saveSettings();
        }
        if (this.settings.autoCommitMessage === undefined) {
            this.settings.autoCommitMessage = this.settings.commitMessage;
            await this.saveSettings();
        }
        if (this.settings.gitPath != undefined) {
            this.localStorage.setGitPath(this.settings.gitPath);
            this.settings.gitPath = undefined;
            await this.saveSettings();
        }
        if (this.settings.username != undefined) {
            this.localStorage.setPassword(this.settings.username);
            this.settings.username = undefined;
            await this.saveSettings();
        }
    }

    unloadPlugin() {
        this.gitReady = false;

        this.editorIntegration.onUnloadPlugin();
        this.automaticsManager.unload();
        this.branchBar?.remove();
        this.statusBar?.remove();
        this.statusBar = undefined;
        this.branchBar = undefined;
        this.gitManager.unload();
        this.promiseQueue.clear();

        for (const interval of this.intervalsToClear) {
            window.clearInterval(interval);
        }
        this.intervalsToClear = [];

        this.debRefresh.cancel();
    }

    onunload() {
        this.unloadPlugin();

        console.log("unloading " + this.manifest.name + " plugin");
    }

    async loadSettings() {
        // At first startup, `data` is `null` because data.json does not exist.
        let data = (await this.loadData()) as ObsidianGitSettings | null;
        //Check for existing settings
        if (data == undefined) {
            data = <ObsidianGitSettings>{ showedMobileNotice: true };
        }
        this.settings = mergeSettingsByPriority(DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        this.settingsTab?.beforeSaveSettings();
        await this.saveData(this.settings);
    }

    get useSimpleGit(): boolean {
        return Platform.isDesktopApp;
    }

    async init({ fromReload = false }): Promise<void> {
        if (this.settings.showStatusBar && !this.statusBar) {
            const statusBarEl = this.addStatusBarItem();
            this.statusBar = new StatusBar(statusBarEl, this);
            this.intervalsToClear.push(
                window.setInterval(() => this.statusBar?.display(), 1000)
            );
        }

        try {
            if (this.useSimpleGit) {
                this.gitManager = new SimpleGit(this);
                await (this.gitManager as SimpleGit).setGitInstance();
            } else {
                this.gitManager = new IsomorphicGit(this);
            }

            const result = await this.gitManager.checkRequirements();
            const pausedAutomatics = this.localStorage.getPausedAutomatics();
            switch (result) {
                case "missing-git":
                    this.displayError(
                        `Cannot run git command. Trying to run: '${this.localStorage.getGitPath() || "git"}' .`
                    );
                    break;
                case "missing-repo":
                    new Notice(
                        "Can't find a valid git repository. Please create one via the given command or clone an existing repo.",
                        10000
                    );
                    break;
                case "valid":
                    this.gitReady = true;
                    this.setPluginState({ gitAction: CurrentGitAction.idle });

                    if (
                        Platform.isDesktop &&
                        this.settings.showBranchStatusBar &&
                        !this.branchBar
                    ) {
                        const branchStatusBarEl = this.addStatusBarItem();
                        this.branchBar = new BranchStatusBar(
                            branchStatusBarEl,
                            this
                        );
                        this.intervalsToClear.push(
                            window.setInterval(
                                () =>
                                    void this.branchBar
                                        ?.display()
                                        .catch(console.error),
                                60000
                            )
                        );
                    }
                    await this.branchBar?.display();

                    this.editorIntegration.onReady();

                    this.app.workspace.trigger("obsidian-git:refresh");
                    /// Among other things, this notifies the history view that git is ready
                    this.app.workspace.trigger("obsidian-git:head-change");

                    if (
                        !fromReload &&
                        this.settings.autoPullOnBoot &&
                        !pausedAutomatics
                    ) {
                        this.promiseQueue.addTask(() =>
                            this.pullChangesFromRemote()
                        );
                    }

                    if (!pausedAutomatics) {
                        await this.automaticsManager.init();
                    }

                    if (pausedAutomatics) {
                        new Notice("Automatic routines are currently paused.");
                    }

                    break;
                default:
                    this.log(
                        "Something weird happened. The 'checkRequirements' result is " +
                            /* eslint-disable-next-line @typescript-eslint/restrict-plus-operands */
                            result
                    );
            }
        } catch (error) {
            this.displayError(error);
            console.error(error);
        }
    }

    async createNewRepo() {
        try {
            await this.gitManager.init();
            new Notice("Initialized new repo");
            await this.init({ fromReload: true });
        } catch (e) {
            this.displayError(e);
        }
    }

    async cloneNewRepo() {
        const modal = new GeneralModal(this, {
            placeholder: "Enter remote URL",
        });
        const url = await modal.openAndGetResult();
        if (url) {
            const confirmOption = "Vault Root";
            let dir = await new GeneralModal(this, {
                options:
                    this.gitManager instanceof IsomorphicGit
                        ? [confirmOption]
                        : [],
                placeholder:
                    "Enter directory for clone. It needs to be empty or not existent.",
                allowEmpty: this.gitManager instanceof IsomorphicGit,
            }).openAndGetResult();
            if (dir == undefined) return;
            if (dir === confirmOption) {
                dir = ".";
            }

            dir = normalizePath(dir);
            if (dir === "/") {
                dir = ".";
            }

            if (dir === ".") {
                const modal = new GeneralModal(this, {
                    options: ["NO", "YES"],
                    placeholder: `Does your remote repo contain a ${this.app.vault.configDir} directory at the root?`,
                    onlySelection: true,
                });
                const containsConflictDir = await modal.openAndGetResult();
                if (containsConflictDir === undefined) {
                    new Notice("Aborted clone");
                    return;
                } else if (containsConflictDir === "YES") {
                    const confirmOption =
                        "DELETE ALL YOUR LOCAL CONFIG AND PLUGINS";
                    const modal = new GeneralModal(this, {
                        options: ["Abort clone", confirmOption],
                        placeholder: `To avoid conflicts, the local ${this.app.vault.configDir} directory needs to be deleted.`,
                        onlySelection: true,
                    });
                    const shouldDelete =
                        (await modal.openAndGetResult()) === confirmOption;
                    if (shouldDelete) {
                        await this.app.vault.adapter.rmdir(
                            this.app.vault.configDir,
                            true
                        );
                    } else {
                        new Notice("Aborted clone");
                        return;
                    }
                }
            }
            const depth = await new GeneralModal(this, {
                placeholder:
                    "Specify depth of clone. Leave empty for full clone.",
                allowEmpty: true,
            }).openAndGetResult();
            let depthInt = undefined;
            if (depth === undefined) {
                new Notice("Aborted clone");
                return;
            }

            if (depth !== "") {
                depthInt = parseInt(depth);
                if (isNaN(depthInt)) {
                    new Notice("Invalid depth. Aborting clone.");
                    return;
                }
            }
            new Notice(`Cloning new repo into "${dir}"`);
            const oldBase = this.settings.basePath;
            const customDir = dir && dir !== ".";
            //Set new base path before clone to ensure proper .git/index file location in isomorphic-git
            if (customDir) {
                this.settings.basePath = dir;
            }
            try {
                await this.gitManager.clone(
                    formatRemoteUrl(url),
                    dir,
                    depthInt
                );
                new Notice("Cloned new repo.");
                new Notice("Please restart Obsidian");

                if (customDir) {
                    await this.saveSettings();
                }
            } catch (error) {
                this.displayError(error);
                this.settings.basePath = oldBase;
                await this.saveSettings();
            }
        }
    }

    /**
     * Retries to call `this.init()` if necessary, otherwise returns directly
     * @returns true if `this.gitManager` is ready to be used, false if not.
     */
    async isAllInitialized(): Promise<boolean> {
        if (!this.gitReady) {
            await this.init({ fromReload: true });
        }
        return this.gitReady;
    }

    ///Used for command
    async pullChangesFromRemote(): Promise<void> {
        if (!(await this.isAllInitialized())) return;

        const filesUpdated = await this.pull();
        if (filesUpdated === false) {
            return;
        }
        if (!filesUpdated) {
            this.displayMessage("Pull: Everything is up-to-date");
        }

        if (this.gitManager instanceof SimpleGit) {
            const status = await this.updateCachedStatus();
            if (status.conflicted.length > 0) {
                this.displayError(
                    `You have conflicts in ${status.conflicted.length} ${
                        status.conflicted.length == 1 ? "file" : "files"
                    }`
                );
                await this.handleConflict(status.conflicted);
            }
        }

        this.app.workspace.trigger("obsidian-git:refresh");
        this.setPluginState({ gitAction: CurrentGitAction.idle });
    }

    async commitAndSync({
        fromAutoBackup,
        requestCustomMessage = false,
        commitMessage,
        onlyStaged = false,
    }: {
        fromAutoBackup: boolean;
        requestCustomMessage?: boolean;
        commitMessage?: string;
        onlyStaged?: boolean;
    }): Promise<void> {
        if (!(await this.isAllInitialized())) return;

        const isDesktop = this.gitManager instanceof SimpleGit;

        // =====================================================================
        // 03번 stash 기반 로직 + 05번 Phase 0/0.5 사전검사
        // (데스크톱 + pullBeforePush에서만 적용)
        // =====================================================================
        if (this.settings.pullBeforePush && isDesktop) {
            const gm = this.gitManager as SimpleGit;

            // ===== Option F Entry-Point Guard — deploy-only plugin path enforcement =====
            // onlyStaged=true 분기 커버 + 알림 발사. onlyStaged=false 분기에서는
            // commitAll의 add -A가 뒤에 있어 여기 reset은 효과 제한적 → simpleGit.ts 내
            // primary guard가 실효 차단 담당. 본 guard는 보조.
            try {
                const userEmail = await gm.getConfig("user.email", "all");
                if (userEmail !== DEPLOYER_EMAIL) {
                    const statusPre = await gm.git.status();
                    const pluginFiles = (statusPre.files ?? [])
                        .map((f) => f.path)
                        .filter((p) => p.startsWith(PLUGIN_PATH_PREFIX));
                    if (pluginFiles.length > 0) {
                        try {
                            await gm.git.reset([
                                "HEAD",
                                "--",
                                ...pluginFiles,
                            ]);
                        } catch (_e) {
                            // reset 실패해도 primary guard가 fallback
                        }
                        await this._emitPluginBlockedAlert({
                            userEmail: userEmail || "(unset)",
                            paths: pluginFiles,
                        });
                    }
                }
            } catch (e) {
                // fail-open: guard 자체 에러로 sync halt 금지 (sentinel이 reactive backstop)
                console.error(
                    "[obsidian-git] plugin-path entry-guard error:",
                    e
                );
            }

            // ===== Phase 0: Pre-flight checks =====
            const danger = await this._preflightCheck();
            if (danger) {
                await this._emitPreflightAlert(danger);
                this.setPluginState({ gitAction: CurrentGitAction.idle });
                return;
            }

            // ===== Phase 0.5: stash push 직전 race 재검 (5-1 보강) =====
            try {
                const recheck = await gm.git.status();
                const recheckDeleted = recheck?.deleted?.length ?? 0;
                if (recheckDeleted >= MASS_DELETE_THRESHOLD) {
                    await this._emitPreflightAlert({
                        prefix: `🚨 Mass-delete detected (${recheckDeleted} files)`,
                        detail: "stash push 직전 재검에서 대량 삭제 감지 (race 보강)",
                    });
                    this.setPluginState({
                        gitAction: CurrentGitAction.idle,
                    });
                    return;
                }
            } catch (_e) {
                // status 실패 시 보수적으로 통과 (사고는 안 막지만 정상 동작 차단도 안 함)
            }

            // ===== Phase 1: stash push -u -m (autostash 식별 메시지) =====
            const userName =
                (await this.gitManager.getConfig("user.name")) || "unknown";
            const stashMsg = `${OBSIDIAN_GIT_AUTOSTASH_TAG} ${new Date().toISOString()} ${userName}`;
            let stashed = false;
            try {
                await gm.git.stash(["push", "-u", "-m", stashMsg]);
                stashed = true;
            } catch (e) {
                const msg = (e as Error)?.message ?? "";
                if (!msg.includes("No local changes")) {
                    this.displayError(e as Error);
                    this.setPluginState({
                        gitAction: CurrentGitAction.idle,
                    });
                    return;
                }
                // "No local changes to save"만 무시
            }

            // ===== Phase 2: pull =====
            // Codex P1-1: this.pull()은 실패 시 false를 반환하지 throw하지 않음.
            // 기존 try/catch만으로는 pull 실패 분기가 dead branch였음.
            let pullOk = true;
            try {
                const pullResult = await this.pull();
                if (pullResult === false) {
                    pullOk = false;
                }
            } catch (e) {
                pullOk = false;
                this.displayError(e as Error);
            }

            // pull 실패 시: stash 복원 시도 후 중단
            if (!pullOk) {
                if (stashed) {
                    try {
                        await gm.git.stash(["pop"]);
                    } catch (_e) {
                        // best-effort; 잔존 stash는 다음 사이클 검사 1-A가 잡음
                    }
                }
                this.setPluginState({ gitAction: CurrentGitAction.idle });
                return;
            }

            // ===== Phase 3: stash pop (성공 시 git이 자동 drop) =====
            if (stashed) {
                try {
                    await gm.git.stash(["pop"]);
                } catch (e) {
                    // stash pop conflict → stash는 잔존 (자동 drop 금지)
                    // 다음 사이클 _preflightCheck 검사 1-A가 Autostash unresolved로 감지
                    // Codex P2: fromStashPop=true 전달하여 handleConflict 알림에
                    // "Autostash unresolved 반복" 연결고리 문구가 부가되도록 함
                    try {
                        const status = await gm.git.status();
                        const conflicted = status.conflicted || [];
                        if (conflicted.length > 0) {
                            await this.handleConflict(conflicted, true);
                        } else {
                            this.displayError(
                                new Error(
                                    `Stash pop failed: ${(e as Error).message}`
                                )
                            );
                        }
                    } catch (_statusErr) {
                        this.displayError(
                            new Error(
                                `Stash pop failed: ${(e as Error).message}`
                            )
                        );
                    }
                    this.setPluginState({
                        gitAction: CurrentGitAction.idle,
                    });
                    return;
                }
            }

            // ===== Phase 4: commit =====
            const commitSuccessful = await this.commit({
                fromAuto: fromAutoBackup,
                requestCustomMessage,
                commitMessage,
                onlyStaged,
            });
            if (!commitSuccessful) {
                this.setPluginState({ gitAction: CurrentGitAction.idle });
                return;
            }

            // ===== Phase 5: push =====
            if (!this.settings.disablePush) {
                if (
                    (await this.remotesAreSet()) &&
                    (await this.gitManager.canPush())
                ) {
                    await this.push();
                } else {
                    this.displayMessage("No commits to push");
                }
            }
            this.setPluginState({ gitAction: CurrentGitAction.idle });
            return;
        }

        // =====================================================================
        // 모바일 (isomorphic-git) 또는 pullBeforePush off: 기존 upstream 로직
        // =====================================================================
        if (
            this.settings.syncMethod == "reset" &&
            this.settings.pullBeforePush
        ) {
            await this.pull();
        }

        const commitSuccessful = await this.commit({
            fromAuto: fromAutoBackup,
            requestCustomMessage,
            commitMessage,
            onlyStaged,
        });
        if (!commitSuccessful) {
            return;
        }

        if (
            this.settings.syncMethod != "reset" &&
            this.settings.pullBeforePush
        ) {
            await this.pull();
        }

        if (!this.settings.disablePush) {
            // Prevent trying to push every time. Only if unpushed commits are present
            if (
                (await this.remotesAreSet()) &&
                (await this.gitManager.canPush())
            ) {
                await this.push();
            } else {
                this.displayMessage("No commits to push");
            }
        }
        this.setPluginState({ gitAction: CurrentGitAction.idle });
    }

    // =========================================================================
    // 05번 §5: Pre-flight check helper (Phase 0)
    // =========================================================================

    /**
     * commitAndSync 진입 직후 실행되는 사전검사.
     * - 검사 1-A: autostash 잔존 (pop conflict 후)
     * - 검사 1-B: 사용자 stash 잔존
     * - 검사 1-mix: 혼재
     * - 검사 2: rebase/merge/cherry-pick 중단
     * - 검사 3: 대량 삭제 (30개 이상)
     *
     * 데스크톱 SimpleGit 경로 전용. 모바일은 호출되지 않음.
     */
    async _preflightCheck(): Promise<PreflightDanger | null> {
        if (!(this.gitManager instanceof SimpleGit)) return null;
        const gm = this.gitManager;

        // ===== 검사 1: stash list 잔존 (1-A / 1-B / 1-mix) =====
        try {
            const stashList: unknown = await gm.git.stash(["list"]);
            // SimpleGit 반환 포맷: string 또는 {all, latest, total}.
            // all[i]는 string 또는 {hash, date, message, diff?} 객체일 수 있음.
            let lines: string[] = [];
            if (typeof stashList === "string") {
                lines = stashList
                    .split("\n")
                    .filter((l) => l.trim().length > 0);
            } else if (
                stashList &&
                typeof stashList === "object" &&
                Array.isArray((stashList as { all?: unknown[] }).all)
            ) {
                const all = (stashList as { all: unknown[] }).all;
                lines = all
                    .map((item) => {
                        if (typeof item === "string") return item;
                        if (item && typeof item === "object") {
                            const rec = item as { message?: string };
                            return rec.message ?? "";
                        }
                        return "";
                    })
                    .filter((s) => s.length > 0);
            }
            const autoLines = lines.filter((l) =>
                l.includes(OBSIDIAN_GIT_AUTOSTASH_TAG)
            );
            const userLines = lines.filter(
                (l) => !l.includes(OBSIDIAN_GIT_AUTOSTASH_TAG)
            );
            if (autoLines.length > 0 && userLines.length > 0) {
                return {
                    prefix: "⚠️ Stash unresolved (mixed)",
                    detail: `autostash ${autoLines.length}개 + 사용자 stash ${userLines.length}개 혼재`,
                };
            }
            if (autoLines.length > 0) {
                return {
                    prefix: "⚠️ Autostash unresolved",
                    detail: `이전 사이클 stash pop 충돌로 autostash ${autoLines.length}개 잔존 (이전 Captain Hook 충돌 알림의 후속 — 동일 사고)`,
                };
            }
            if (userLines.length > 0) {
                return {
                    prefix: "⚠️ Pre-stash detected",
                    detail: `git stash list에 사용자 stash ${userLines.length}개 발견`,
                };
            }
        } catch (_e) {
            // stash 명령 자체가 실패하면 보수적으로 통과
        }

        // ===== 검사 2: rebase/merge/cherry-pick 중단 =====
        // Codex P1-2: vault root 기준 .git/* 파일 직접 검사는 basePath/gitDir 설정과
        // 충돌하여 false negative를 일으킴. 대신 simple-git의 revparse --verify로
        // git이 인식하는 ref 경로를 사용한다 (gitDir 설정 자동 반영).
        const midStateRefs: { ref: string; type: string }[] = [
            { ref: "MERGE_HEAD", type: "merge" },
            { ref: "REBASE_HEAD", type: "rebase" },
            { ref: "CHERRY_PICK_HEAD", type: "cherry-pick" },
            { ref: "REVERT_HEAD", type: "revert" },
        ];
        for (const r of midStateRefs) {
            try {
                const out = await gm.git.revparse([
                    "--verify",
                    "--quiet",
                    r.ref,
                ]);
                if (out && out.trim().length > 0) {
                    return {
                        prefix: "⚠️ Mid-rebase detected",
                        detail: `${r.ref} 잔존 — ${r.type} 중단 상태`,
                    };
                }
            } catch (_e) {
                // ref가 존재하지 않으면 throw → 정상
            }
        }
        // 인터랙티브 rebase는 ref가 아니라 별도 디렉토리(rebase-merge/)에 상태를 둔다.
        // paused 상태(edit/break 등)에서는 REBASE_HEAD가 비어 있어도 디렉토리는 남는다.
        try {
            const rebaseMergePath = (
                await gm.git.revparse(["--git-path", "rebase-merge"])
            ).trim();
            if (rebaseMergePath) {
                const adapter = this.app.vault.adapter as FileSystemAdapter;
                const vaultRelativePath = path.isAbsolute(rebaseMergePath)
                    ? normalizePath(
                          path.relative(
                              adapter.getBasePath(),
                              rebaseMergePath
                          )
                      )
                    : gm.getRelativeVaultPath(rebaseMergePath);
                if (await adapter.exists(vaultRelativePath)) {
                    return {
                        prefix: "⚠️ Mid-rebase detected",
                        detail: "rebase-merge 디렉터리 잔존 — 인터랙티브 rebase 중단 상태",
                    };
                }
            }
        } catch (_e) {
            // best-effort
        }

        // ===== 검사 3: 대량 삭제 감지 =====
        try {
            const status = await gm.git.status();
            const deletedCount = status?.deleted?.length ?? 0;
            if (deletedCount >= MASS_DELETE_THRESHOLD) {
                return {
                    prefix: `🚨 Mass-delete detected (${deletedCount} files)`,
                    detail: `삭제 파일 ${deletedCount}건 감지 (auto-commit 진입 시점)`,
                };
            }
        } catch (_e) {
            // status 실패는 보수적으로 통과
        }

        return null;
    }

    /**
     * 사전검사 위험 감지 시 디스코드 + Obsidian Modal 동시 발사.
     * - de-dup 없음 (사용자 결정: 10분마다 반복 알림)
     * - 둘 다 실패해도 사이클 스킵 로직은 영향 없음
     */
    async _emitPreflightAlert(danger: PreflightDanger): Promise<void> {
        const userName =
            (await this.gitManager.getConfig("user.name")) || "unknown";

        // (1) 디스코드 알림 (외부 인지, 휴대폰 푸시 도달)
        // webhook URL은 data.json 우선, localStorage 폴백 (2026-04-22 Option-1)
        const { webhookUrl, mentionId } = getCaptainHookConfig(this);
        if (webhookUrl) {
            try {
                const mentionPrefix = mentionId ? `<@${mentionId}> ` : "";
                await requestUrl({
                    url: webhookUrl,
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        content: `${mentionPrefix}**${danger.prefix}**\n사용자: ${userName}\n사유: ${danger.detail}\n→ auto-commit 사이클을 스킵합니다. 즉시 이한덕에게 문의하세요.\n(auto-pull은 정상 동작합니다)`,
                    }),
                });
            } catch (_e) {
                // 네트워크 차단 등 — 사이클 차단까진 안 하도록 무시
            }
        }
        // webhook URL이 설정되지 않은 PC: 디스코드 silent skip, Modal은 그대로 발사

        // (2) Obsidian Modal 팝업 (확인 버튼 없음, 10초 자동 닫힘)
        try {
            new PreflightWarningModal(
                this.app,
                danger.prefix,
                danger.detail
            ).open();
        } catch (_e) {
            // Modal 생성 실패도 무시
        }
    }

    /**
     * Option F: plugin-path-guard 알림. Discord (외부 인지) + Notice (사고 PC 본인 인지).
     * Rate-limit 1시간 — 05번 §3 "de-dup 없음" 과 차별화 (Fix 4).
     * plugin-block-guard는 sync-halting 아니고 팀원 actionable 아니며 데이터 손실 없음.
     * 호출부: simpleGit.ts commitAll() primary guard, main.ts commitAndSync entry-point guard.
     */
    _pluginBlockAlertLastFired = 0;
    async _emitPluginBlockedAlert(args: {
        userEmail: string;
        paths: string[];
    }): Promise<void> {
        const now = Date.now();
        if (
            now - this._pluginBlockAlertLastFired <
            PLUGIN_BLOCK_RATE_LIMIT_MS
        ) {
            return;
        }
        this._pluginBlockAlertLastFired = now;

        const userName =
            (await this.gitManager.getConfig("user.name", "all")) || "unknown";
        const fileList = args.paths.join("\n  - ");

        const { webhookUrl, mentionId } = getCaptainHookConfig(this);
        if (webhookUrl) {
            try {
                const mentionPrefix = mentionId ? `<@${mentionId}> ` : "";
                await requestUrl({
                    url: webhookUrl,
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        content:
                            `${mentionPrefix}**🛡️ Plugin path staging blocked**\n` +
                            `사용자: ${userName} (${args.userEmail})\n` +
                            `차단 파일:\n  - ${fileList}\n` +
                            `→ 배포는 이한덕 전담. 이 PC에서 plugin 파일 push 시도는 자동 차단됨.\n` +
                            `(1시간 rate-limit — 동일 PC 반복 알림 억제)`,
                    }),
                });
            } catch (_e) {
                // 네트워크 차단 등 무시 (fail-open)
            }
        }

        try {
            new Notice(
                `[obsidian-git] plugin 경로 staging 차단 (${args.paths.length}개 파일). 배포는 이한덕 통해 진행.`,
                7000
            );
        } catch (_e) {
            // Notice 실패 무시
        }
    }

    // Returns true if commit was successfully
    async commit({
        fromAuto,
        requestCustomMessage = false,
        onlyStaged = false,
        commitMessage,
        amend = false,
    }: {
        fromAuto: boolean;
        requestCustomMessage?: boolean;
        onlyStaged?: boolean;
        commitMessage?: string;
        amend?: boolean;
    }): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;
        try {
            let hadConflict = this.localStorage.getConflict();

            let status: Status | undefined;
            let stagedFiles: { vaultPath: string; path: string }[] = [];
            let unstagedFiles: (UnstagedFile & { vaultPath: string })[] = [];

            if (this.gitManager instanceof SimpleGit) {
                await this.mayDeleteConflictFile();
                status = await this.updateCachedStatus();

                //Should not be necessary, but just in case
                if (status.conflicted.length == 0) {
                    hadConflict = false;
                }

                // check for conflict files on auto backup
                if (fromAuto && status.conflicted.length > 0) {
                    this.displayError(
                        `Did not commit, because you have conflicts in ${
                            status.conflicted.length
                        } ${
                            status.conflicted.length == 1 ? "file" : "files"
                        }. Please resolve them and commit per command.`
                    );
                    await this.handleConflict(status.conflicted);
                    return false;
                }
                stagedFiles = status.staged;

                // This typecast is only needed to hide the fact that `type` is missing, but that is only needed for isomorphic-git
                unstagedFiles = status.changed as unknown as (UnstagedFile & {
                    vaultPath: string;
                })[];
            } else {
                // isomorphic-git section

                if (fromAuto && hadConflict) {
                    // isomorphic-git doesn't have a way to detect current
                    // conflicts, they are only detected on commit
                    //
                    // Conflicts should only be resolved by manually committing.
                    this.displayError(
                        `Did not commit, because you have conflicts. Please resolve them and commit per command.`
                    );
                    return false;
                } else {
                    if (hadConflict) {
                        await this.mayDeleteConflictFile();
                    }
                    const gitManager = this.gitManager as IsomorphicGit;
                    if (onlyStaged) {
                        stagedFiles = await gitManager.getStagedFiles();
                    } else {
                        const res = await gitManager.getUnstagedFiles();
                        unstagedFiles = res.map(({ path, type }) => ({
                            vaultPath:
                                this.gitManager.getRelativeVaultPath(path),
                            path,
                            type,
                        }));
                    }
                }
            }

            if (
                await this.tools.hasTooBigFiles(
                    onlyStaged
                        ? stagedFiles
                        : [...stagedFiles, ...unstagedFiles]
                )
            ) {
                this.setPluginState({ gitAction: CurrentGitAction.idle });
                return false;
            }

            if (
                unstagedFiles.length + stagedFiles.length !== 0 ||
                hadConflict
            ) {
                // The commit message from settings or previously set in the
                // source control view
                let cmtMessage = (commitMessage ??= fromAuto
                    ? this.settings.autoCommitMessage
                    : this.settings.commitMessage);

                // Optionally ask the user via a modal for a commit message
                if (
                    (fromAuto && this.settings.customMessageOnAutoBackup) ||
                    requestCustomMessage
                ) {
                    if (!this.settings.disablePopups && fromAuto) {
                        new Notice(
                            "Auto backup: Please enter a custom commit message. Leave empty to abort"
                        );
                    }
                    const modalMessage = await new CustomMessageModal(
                        this
                    ).openAndGetResult();

                    if (
                        modalMessage != undefined &&
                        modalMessage != "" &&
                        modalMessage != "..."
                    ) {
                        cmtMessage = modalMessage;
                    } else {
                        this.setPluginState({
                            gitAction: CurrentGitAction.idle,
                        });
                        return false;
                    }

                    // On desktop may run a script to get the commit message
                } else if (
                    this.gitManager instanceof SimpleGit &&
                    this.settings.commitMessageScript
                ) {
                    const templateScript = this.settings.commitMessageScript;
                    const hostname = this.localStorage.getHostname() || "";
                    let formattedScript = templateScript.replace(
                        "{{hostname}}",
                        hostname
                    );

                    formattedScript = formattedScript.replace(
                        "{{date}}",
                        moment().format(this.settings.commitDateFormat)
                    );

                    const res = await spawnAsync(
                        "sh",
                        ["-c", formattedScript],
                        { cwd: this.gitManager.absoluteRepoPath }
                    );
                    if (res.code != 0) {
                        this.displayError(res.stderr);
                    } else if (res.stdout.trim().length == 0) {
                        this.displayMessage(
                            "Stdout from commit message script is empty. Using default message."
                        );
                    } else {
                        cmtMessage = res.stdout;
                    }
                }

                // Check if commit message is empty after all processing
                if (!cmtMessage || cmtMessage.trim() === "") {
                    new Notice("Commit aborted: No commit message provided");
                    this.setPluginState({
                        gitAction: CurrentGitAction.idle,
                    });
                    return false;
                }

                let committedFiles: number | undefined;
                if (onlyStaged) {
                    committedFiles = await this.gitManager.commit({
                        message: cmtMessage,
                        amend,
                    });
                } else {
                    committedFiles = await this.gitManager.commitAll({
                        message: cmtMessage,
                        status,
                        unstagedFiles,
                        amend,
                    });
                }

                // Handle eventually resolved conflicts
                if (this.gitManager instanceof SimpleGit) {
                    await this.updateCachedStatus();
                }

                let roughly = false;
                if (committedFiles === undefined) {
                    roughly = true;
                    committedFiles =
                        unstagedFiles.length + stagedFiles.length || 0;
                }
                this.displayMessage(
                    `Committed${roughly ? " approx." : ""} ${committedFiles} ${
                        committedFiles == 1 ? "file" : "files"
                    }`
                );
            } else {
                this.displayMessage("No changes to commit");
            }
            this.app.workspace.trigger("obsidian-git:refresh");

            return true;
        } catch (error) {
            this.displayError(error);
            return false;
        }
    }

    /*
     * Returns true if push was successful
     */
    async push(): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;
        if (!(await this.remotesAreSet())) {
            return false;
        }
        const hadConflict = this.localStorage.getConflict();
        try {
            if (this.gitManager instanceof SimpleGit)
                await this.mayDeleteConflictFile();

            // Refresh because of pull
            let status: Status;
            if (
                this.gitManager instanceof SimpleGit &&
                (status = await this.updateCachedStatus()).conflicted.length > 0
            ) {
                this.displayError(
                    `Cannot push. You have conflicts in ${
                        status.conflicted.length
                    } ${status.conflicted.length == 1 ? "file" : "files"}`
                );
                await this.handleConflict(status.conflicted);
                return false;
            } else if (
                this.gitManager instanceof IsomorphicGit &&
                hadConflict
            ) {
                this.displayError(`Cannot push. You have conflicts`);
                return false;
            }
            this.log("Pushing....");
            const pushedFiles = await this.gitManager.push();

            if (pushedFiles !== undefined) {
                if (pushedFiles === null) {
                    this.displayMessage(`Pushed to remote`);
                } else if (pushedFiles > 0) {
                    this.displayMessage(
                        `Pushed ${pushedFiles} ${
                            pushedFiles == 1 ? "file" : "files"
                        } to remote`
                    );
                } else {
                    this.displayMessage(`No commits to push`);
                }
            }
            this.setPluginState({ offlineMode: false });
            this.app.workspace.trigger("obsidian-git:refresh");
            return true;
        } catch (e) {
            if (e instanceof NoNetworkError) {
                this.handleNoNetworkError(e);
            } else {
                this.displayError(e);
            }
            return false;
        }
    }

    /** Used for internals
     *  Returns whether the pull added a commit or not.
     *
     *  See {@link pullChangesFromRemote} for the command version.
     */
    async pull(): Promise<false | number> {
        if (!(await this.remotesAreSet())) {
            return false;
        }
        try {
            this.log("Pulling....");
            const pulledFiles = (await this.gitManager.pull()) || [];
            this.setPluginState({ offlineMode: false });

            if (pulledFiles.length > 0) {
                this.displayMessage(
                    `Pulled ${pulledFiles.length} ${
                        pulledFiles.length == 1 ? "file" : "files"
                    } from remote`
                );
                this.lastPulledFiles = pulledFiles;
            }
            return pulledFiles.length;
        } catch (e) {
            this.displayError(e);

            return false;
        }
    }

    async fetch(): Promise<void> {
        if (!(await this.remotesAreSet())) {
            return;
        }
        try {
            await this.gitManager.fetch();

            this.displayMessage(`Fetched from remote`);
            this.setPluginState({ offlineMode: false });
            this.app.workspace.trigger("obsidian-git:refresh");
        } catch (error) {
            this.displayError(error);
        }
    }

    async mayDeleteConflictFile(): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(CONFLICT_OUTPUT_FILE);
        if (file) {
            this.app.workspace.iterateAllLeaves((leaf) => {
                if (
                    leaf.view instanceof MarkdownView &&
                    leaf.view.file?.path == file.path
                ) {
                    leaf.detach();
                }
            });
            await this.app.vault.delete(file);
        }
    }

    async stageFile(file: TFile): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;

        await this.gitManager.stage(file.path, true);

        this.app.workspace.trigger("obsidian-git:refresh");

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        return true;
    }

    async unstageFile(file: TFile): Promise<boolean> {
        if (!(await this.isAllInitialized())) return false;

        await this.gitManager.unstage(file.path, true);

        this.app.workspace.trigger("obsidian-git:refresh");

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        return true;
    }

    async switchBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const branchInfo = await this.gitManager.branchInfo();
        const selectedBranch = await new BranchModal(
            this,
            branchInfo.branches
        ).openAndGetReslt();

        if (selectedBranch != undefined) {
            await this.gitManager.checkout(selectedBranch);
            this.displayMessage(`Switched to ${selectedBranch}`);
            this.app.workspace.trigger("obsidian-git:refresh");
            await this.branchBar?.display();
            return selectedBranch;
        }
    }

    async switchRemoteBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const selectedBranch = (await this.selectRemoteBranch()) || "";

        const [remote, branch] = splitRemoteBranch(selectedBranch);

        if (branch != undefined && remote != undefined) {
            await this.gitManager.checkout(branch, remote);
            this.displayMessage(`Switched to ${selectedBranch}`);
            await this.branchBar?.display();
            return selectedBranch;
        }
    }

    async createBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const newBranch = await new GeneralModal(this, {
            placeholder: "Create new branch",
        }).openAndGetResult();
        if (newBranch != undefined) {
            await this.gitManager.createBranch(newBranch);
            this.displayMessage(`Created new branch ${newBranch}`);
            await this.branchBar?.display();
            return newBranch;
        }
    }

    async deleteBranch(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const branchInfo = await this.gitManager.branchInfo();
        if (branchInfo.current) branchInfo.branches.remove(branchInfo.current);
        const branch = await new GeneralModal(this, {
            options: branchInfo.branches,
            placeholder: "Delete branch",
            onlySelection: true,
        }).openAndGetResult();
        if (branch != undefined) {
            let force = false;
            const merged = await this.gitManager.branchIsMerged(branch);
            // Using await inside IF throws exception
            if (!merged) {
                const forceAnswer = await new GeneralModal(this, {
                    options: ["YES", "NO"],
                    placeholder:
                        "This branch isn't merged into HEAD. Force delete?",
                    onlySelection: true,
                }).openAndGetResult();
                if (forceAnswer !== "YES") {
                    return;
                }
                force = forceAnswer === "YES";
            }
            await this.gitManager.deleteBranch(branch, force);
            this.displayMessage(`Deleted branch ${branch}`);
            await this.branchBar?.display();
            return branch;
        }
    }

    /** Ensures that the upstream branch is set.
     * If not, it will prompt the user to set it.
     *
     * An exception is when the user has submodules enabled.
     * In this case, the upstream branch is not required,
     * to allow pulling/pushing only the submodules and not the outer repo.
     */
    async remotesAreSet(): Promise<boolean> {
        if (this.settings.updateSubmodules) {
            return true;
        }
        if (
            this.gitManager instanceof SimpleGit &&
            (await this.gitManager.getConfig("push.autoSetupRemote", "all")) ==
                "true"
        ) {
            return true;
        }
        if (!(await this.gitManager.branchInfo()).tracking) {
            new Notice("No upstream branch is set. Please select one.");
            return await this.setUpstreamBranch();
        }
        return true;
    }

    async setUpstreamBranch(): Promise<boolean> {
        const remoteBranch = await this.selectRemoteBranch();

        if (remoteBranch == undefined) {
            this.displayError("Aborted. No upstream-branch is set!", 10000);
            this.setPluginState({ gitAction: CurrentGitAction.idle });
            return false;
        } else {
            await this.gitManager.updateUpstreamBranch(remoteBranch);
            this.displayMessage(`Set upstream branch to ${remoteBranch}`);
            this.setPluginState({ gitAction: CurrentGitAction.idle });
            return true;
        }
    }

    async discardAll(path?: string): Promise<DiscardResult> {
        if (!(await this.isAllInitialized())) return false;

        const status = await this.gitManager.status({ path });

        let filesToDeleteCount = 0;
        let filesToDiscardCount = 0;
        for (const file of status.changed) {
            if (file.workingDir == "U") {
                filesToDeleteCount++;
            } else {
                filesToDiscardCount++;
            }
        }
        if (filesToDeleteCount + filesToDiscardCount == 0) {
            return false;
        }

        const result = await new DiscardModal({
            app: this.app,
            filesToDeleteCount,
            filesToDiscardCount,
            path: path ?? "",
        }).openAndGetResult();

        switch (result) {
            case false:
                return result;
            case "discard":
                await this.gitManager.discardAll({
                    dir: path,
                    status: this.cachedStatus,
                });
                break;
            case "delete": {
                await this.gitManager.discardAll({
                    dir: path,
                    status: this.cachedStatus,
                });
                const untrackedPaths = await this.gitManager.getUntrackedPaths({
                    path,
                    status: this.cachedStatus,
                });
                for (const file of untrackedPaths) {
                    const vaultPath =
                        this.gitManager.getRelativeVaultPath(file);
                    const tFile =
                        this.app.vault.getAbstractFileByPath(vaultPath);

                    if (tFile) {
                        await this.app.fileManager.trashFile(tFile);
                    } else {
                        if (file.endsWith("/")) {
                            await this.app.vault.adapter.rmdir(vaultPath, true);
                        } else {
                            await this.app.vault.adapter.remove(vaultPath);
                        }
                    }
                }
                break;
            }
            default:
                assertNever(result);
        }
        this.app.workspace.trigger("obsidian-git:refresh");
        return result;
    }

    async handleConflict(
        conflicted?: string[],
        fromStashPop: boolean = false
    ): Promise<void> {
        this.localStorage.setConflict(true);
        let lines: string[] | undefined;
        if (conflicted !== undefined) {
            lines = [
                "# Conflicts",
                "Please resolve them and commit them using the commands `Git: Commit all changes` followed by `Git: Push`",
                "(This file will automatically be deleted before commit)",
                "[[#Additional Instructions]] available below file list",
                "",
                ...conflicted.map((e) => {
                    const file = this.app.vault.getAbstractFileByPath(e);
                    if (file instanceof TFile) {
                        const link = this.app.metadataCache.fileToLinktext(
                            file,
                            "/"
                        );
                        return `- [[${link}]]`;
                    } else {
                        return `- Not a file: ${e}`;
                    }
                }),
                `
# Additional Instructions
I strongly recommend to use "Source mode" for viewing the conflicted files. For simple conflicts, in each file listed above replace every occurrence of the following text blocks with the desired text.

\`\`\`diff
<<<<<<< HEAD
    File changes in local repository
=======
    File changes in remote repository
>>>>>>> origin/main
\`\`\``,
            ];
        }
        await this.tools.writeAndOpenFile(lines?.join("\n"));

        // =====================================================================
        // Captain Hook 디스코드 알림
        // - webhook URL: data.json 우선, localStorage 폴백 (2026-04-22 Option-1)
        // - 05번 연결고리 문구는 stash pop 충돌일 때만 부가 (Codex P2)
        //   handleConflict는 일반 commit/pull/merge 충돌에서도 호출되는데,
        //   stash와 무관한 충돌에 "Autostash unresolved 반복" 안내가 잘못 나가지 않도록
        //   호출자가 fromStashPop=true를 명시할 때만 chain warning 추가
        // =====================================================================
        const { webhookUrl, mentionId } = getCaptainHookConfig(this);
        if (webhookUrl) {
            try {
                const userName =
                    (await this.gitManager.getConfig("user.name")) ||
                    "unknown";
                const conflictList = (conflicted ?? []).join(", ");
                const mentionPrefix = mentionId ? `<@${mentionId}> ` : "";
                const chainWarning = fromStashPop
                    ? `\n⚠️ stash 잔존 상태 — 다음 사이클부터 "Autostash unresolved" 알림이 10분마다 반복됩니다. 정리까지 이한덕에게 문의하세요.`
                    : "";
                const content =
                    `${mentionPrefix}**⚠️ Vault Git 충돌 발생!**\n` +
                    `사용자: ${userName}\n` +
                    `충돌 파일: ${conflictList}` +
                    chainWarning;
                await requestUrl({
                    url: webhookUrl,
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content }),
                });
            } catch (_discordErr) {
                // Discord 알림 실패는 무시 (핵심 동작 아님)
            }
        }
        // webhook URL이 설정되지 않은 PC: 디스코드 silent skip
    }

    async editRemotes(): Promise<string | undefined> {
        if (!(await this.isAllInitialized())) return;

        const remotes = await this.gitManager.getRemotes();

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder:
                "Select or create a new remote by typing its name and selecting it",
        });
        const remoteName = await nameModal.openAndGetResult();

        if (remoteName) {
            const oldUrl = await this.gitManager.getRemoteUrl(remoteName);

            const urlModal = new GeneralModal(this, {
                initialValue: oldUrl,
                placeholder: "Enter remote URL",
            });
            // urlModal.inputEl.setText(oldUrl ?? "");
            const remoteURL = await urlModal.openAndGetResult();
            if (remoteURL) {
                await this.gitManager.setRemote(
                    remoteName,
                    formatRemoteUrl(remoteURL)
                );
                return remoteName;
            }
        }
    }

    async selectRemoteBranch(): Promise<string | undefined> {
        let remotes = await this.gitManager.getRemotes();
        let selectedRemote: string | undefined;
        if (remotes.length === 0) {
            selectedRemote = await this.editRemotes();
            if (selectedRemote == undefined) {
                remotes = await this.gitManager.getRemotes();
            }
        }

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder:
                "Select or create a new remote by typing its name and selecting it",
        });
        const remoteName =
            selectedRemote ?? (await nameModal.openAndGetResult());

        if (remoteName) {
            this.displayMessage("Fetching remote branches");
            await this.gitManager.fetch(remoteName);
            const branches =
                await this.gitManager.getRemoteBranches(remoteName);
            const branchModal = new GeneralModal(this, {
                options: branches,
                placeholder:
                    "Select or create a new remote branch by typing its name and selecting it",
            });
            const branch = await branchModal.openAndGetResult();
            if (branch == undefined) return;
            if (!branch.startsWith(remoteName + "/")) {
                // If the branch does not start with the remote name, prepend it
                return `${remoteName}/${branch}`;
            }
            return branch; // Already in the correct format
        }
    }

    async removeRemote() {
        if (!(await this.isAllInitialized())) return;

        const remotes = await this.gitManager.getRemotes();

        const nameModal = new GeneralModal(this, {
            options: remotes,
            placeholder: "Select a remote",
        });
        const remoteName = await nameModal.openAndGetResult();

        if (remoteName) {
            await this.gitManager.removeRemote(remoteName);
        }
    }

    onActiveLeafChange(leaf: WorkspaceLeaf | null): void {
        const view = leaf?.view;
        // Prevent removing focus when switching to other panes than file panes like search or GitView
        if (
            !view?.getState().file &&
            !(view instanceof DiffView || view instanceof SplitDiffView)
        )
            return;

        const sourceControlLeaf = this.app.workspace
            .getLeavesOfType(SOURCE_CONTROL_VIEW_CONFIG.type)
            .first();
        const historyLeaf = this.app.workspace
            .getLeavesOfType(HISTORY_VIEW_CONFIG.type)
            .first();

        // Clear existing active state
        sourceControlLeaf?.view.containerEl
            .querySelector(`div.tree-item-self.is-active`)
            ?.removeClass("is-active");
        historyLeaf?.view.containerEl
            .querySelector(`div.tree-item-self.is-active`)
            ?.removeClass("is-active");

        if (
            leaf?.view instanceof DiffView ||
            leaf?.view instanceof SplitDiffView
        ) {
            const path = leaf.view.state.bFile;
            const escapedPath = path.replace(/["\\]/g, "\\$&");
            this.lastDiffViewState = leaf.view.getState();
            let el: Element | undefined | null;
            if (sourceControlLeaf && leaf.view.state.aRef == "HEAD") {
                el = sourceControlLeaf.view.containerEl.querySelector(
                    `div.staged div.tree-item-self[data-path="${escapedPath}"]`
                );
            } else if (sourceControlLeaf && leaf.view.state.aRef == "") {
                el = sourceControlLeaf.view.containerEl.querySelector(
                    `div.changes div.tree-item-self[data-path="${escapedPath}"]`
                );
            } else if (historyLeaf) {
                el = historyLeaf.view.containerEl.querySelector(
                    `div.tree-item-self[data-path='${escapedPath}']`
                );
            }
            el?.addClass("is-active");
        } else {
            this.lastDiffViewState = undefined;
        }
    }

    handleNoNetworkError(_: NoNetworkError): void {
        if (!this.state.offlineMode) {
            this.displayError(
                "Git: Going into offline mode. Future network errors will no longer be displayed.",
                2000
            );
        } else {
            this.log("Encountered network error, but already in offline mode");
        }
        this.setPluginState({
            gitAction: CurrentGitAction.idle,
            offlineMode: true,
        });
    }

    // region: displaying / formatting messages
    displayMessage(message: string, timeout: number = 4 * 1000): void {
        this.statusBar?.displayMessage(message.toLowerCase(), timeout);

        if (!this.settings.disablePopups) {
            if (
                !this.settings.disablePopupsForNoChanges ||
                !message.startsWith("No changes")
            ) {
                new Notice(message, 5 * 1000);
            }
        }

        this.log(message);
    }

    displayError(data: unknown, timeout: number = 10 * 1000): void {
        if (data instanceof Errors.UserCanceledError) {
            new Notice("Aborted");
            return;
        }
        let error: Error;
        if (data instanceof Error) {
            error = data;
        } else {
            error = new Error(String(data));
        }

        this.setPluginState({ gitAction: CurrentGitAction.idle });
        if (this.settings.showErrorNotices) {
            new Notice(error.message, timeout);
        }
        console.error(`${this.manifest.id}:`, error.stack);
        this.statusBar?.displayMessage(error.message.toLowerCase(), timeout);
    }

    log(...data: unknown[]) {
        console.log(`${this.manifest.id}:`, ...data);
    }
}
