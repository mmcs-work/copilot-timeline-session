import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";

// execFile runs Git directly, without opening a shell.
// Turning it into a promise lets us use the beginner-friendly async/await syntax.
const execFileAsync = promisify(execFile);

// VS Code automatically loads hook files from this folder.
const hookFileName = ".github/hooks/copilot-timeline.json";
// These are intentionally ordinary visible files because file watchers can
// skip hidden files on some operating systems.
const startMarkerName = "copilot-timeline-start";
const stopMarkerName = "copilot-timeline-stop";
const detailMarkerName = "copilot-timeline-detail.json";
const savedSessionKey = "copilotTimelineSession";

type CheckpointDetail = {
  prompt?: string;
  response?: string;
  model?: string;
  important?: boolean;
};

type SavedSession = {
  repositoryFolder: string;
  originalBranch: string;
  sessionBranch: string;
  untrackedFiles: string[];
  checkpointDetails: Record<string, CheckpointDetail>;
  sessionNote?: string;
};

// Older versions stored prompts by themselves. Keep those visible when a
// session started with an older version is reopened after an update.
function oldPromptDetails(session: SavedSession): Record<string, CheckpointDetail> {
  const oldPrompts = (session as SavedSession & { checkpointPrompts?: Record<string, string> }).checkpointPrompts || {};
  return Object.fromEntries(Object.entries(oldPrompts).map(([hash, prompt]) => [hash, { prompt }]));
}

// The active window keeps the session in memory. A tiny saved record lets the
// extension continue after VS Code reloads.
let repositoryFolder: string | undefined;
let originalBranch: string | undefined;
let sessionBranch: string | undefined;
let untrackedFiles: string[] = [];
let checkpointDetails: Record<string, CheckpointDetail> = {};
let sessionNote = "";
let promptForNextCheckpoint: string | undefined;
let responseForNextCheckpoint: string | undefined;
let modelForNextCheckpoint: string | undefined;
let checkpointNumber = 0;
let commitTimer: NodeJS.Timeout | undefined;
let commitWork: Promise<void> = Promise.resolve();
let finishing = false;
let copilotIsWorking = false;
let commitMessageModel: vscode.LanguageModelChat | undefined;
let sessionStore: vscode.Memento;
let extensionFolder = "";

let startButton: vscode.StatusBarItem;
let finishButton: vscode.StatusBarItem;
let sessionStatus: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  sessionStore = context.globalState;
  extensionFolder = context.extensionUri.fsPath;
  // These two commands appear in the Command Palette.
  const startCommand = vscode.commands.registerCommand(
    "copilotTimeline.start",
    startSession
  );
  const finishCommand = vscode.commands.registerCommand(
    "copilotTimeline.finish",
    finishSession
  );
  const openCommand = vscode.commands.registerCommand(
    "copilotTimeline.open",
    openSession
  );

  // The status bar shows only the action that currently makes sense.
  startButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  startButton.text = "$(play) Start Copilot Session";
  startButton.command = "copilotTimeline.start";
  startButton.tooltip = "Create a branch and start making Copilot checkpoints";

  finishButton = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  finishButton.text = "$(check) Finish Copilot Session";
  finishButton.command = "copilotTimeline.finish";
  finishButton.tooltip = "Squash the Copilot session back into the original branch";

  // This is only a small reminder. It makes it clear that Copilot work is
  // going into a separate session branch.
  sessionStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    99
  );

  startButton.show();

  // Watch saved, created, and deleted files in the workspace.
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidChange(noticeFileChange);
  watcher.onDidCreate(noticeFileChange);
  watcher.onDidDelete(noticeRepositoryChange);

  context.subscriptions.push(
    startCommand,
    finishCommand,
    openCommand,
    startButton,
    finishButton,
    sessionStatus,
    watcher
  );

  // Remember just enough state to continue a session after VS Code reloads.
  const saved = sessionStore.get<SavedSession>(savedSessionKey);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const activeBranch = folder ? await getCurrentBranch(folder) : undefined;
  if (saved && folder === saved.repositoryFolder && activeBranch === saved.sessionBranch) {
    repositoryFolder = saved.repositoryFolder;
    originalBranch = saved.originalBranch;
    sessionBranch = saved.sessionBranch;
    untrackedFiles = saved.untrackedFiles || [];
    checkpointDetails = saved.checkpointDetails || oldPromptDetails(saved);
    sessionNote = saved.sessionNote || "";
    startButton.hide();
    finishButton.show();
    const count = await runGit("rev-list", "--count", `${originalBranch}..${sessionBranch}`);
    checkpointNumber = Number(count) || 0;
    updateSessionStatus();

    // The Start command already asked for Copilot permission. A model object
    // cannot be saved between windows, so get a fresh one for this window.
    if (getSetting("generateCommitMessages", true)) {
      try {
        const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
        commitMessageModel = models[0];
      } catch {
        // Generic checkpoint messages still work when Copilot is unavailable.
      }
    }
  } else if (saved && await pathExists(saved.repositoryFolder)) {
    showOpenSessionButton();
  }
}

async function startSession() {
  let saved = sessionStore.get<SavedSession>(savedSessionKey);
  // A repository folder may have been removed outside VS Code. Forget only
  // that stale record, so it does not permanently block a new session.
  if (saved && !(await pathExists(saved.repositoryFolder))) {
    await sessionStore.update(savedSessionKey, undefined);
    saved = undefined;
  }

  if (sessionBranch || saved) {
    vscode.window.showInformationMessage("A Copilot session is already running.");
    return;
  }

  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    return;
  }
  if (folders.length > 1) {
    vscode.window.showWarningMessage("Copilot Timeline Session works with one repository folder at a time.");
    return;
  }

  const startingFolder = folders[0].uri.fsPath;
  if (!(await isGitRepository(startingFolder))) {
    return;
  }

  // Never overwrite a hook file the user or another tool may already own.
  if (await pathExists(path.join(startingFolder, hookFileName))) {
    vscode.window.showWarningMessage(
      "Copilot Timeline's hook file already exists. Finish or reopen that session, or rename the file before starting a new one."
    );
    return;
  }

  try {
    // Git branches do not need a second folder. Existing untracked files stay
    // right here, which lets local files such as .env keep working.
    const branch = await runGitInFolder(startingFolder, "branch", "--show-current");
    if (!branch) {
      return;
    }

    if (await hasTrackedChanges(startingFolder)) {
      vscode.window.showWarningMessage(
        "Commit or stash existing tracked changes before starting a Copilot session. Existing untracked files are fine."
      );
      return;
    }

    // Git needs these before it can make any checkpoint commits.
    const name = await runGitInFolder(startingFolder, "config", "user.name");
    const email = await runGitInFolder(startingFolder, "config", "user.email");
    if (!name || !email) {
      throw new Error(
        "Set your Git name and email first. Run: git config --global user.name \\\"Your Name\\\" and git config --global user.email \\\"you@example.com\\\""
      );
    }

    // Remember pre-existing untracked files. Ignored files already stay out of
    // `git add -A`, while these ordinary untracked files need explicit help.
    originalBranch = branch;
    sessionBranch = makeSessionBranchName();
    untrackedFiles = await getUntrackedFiles(startingFolder);
    checkpointDetails = {};
    sessionNote = "";
    promptForNextCheckpoint = undefined;
    responseForNextCheckpoint = undefined;
    modelForNextCheckpoint = undefined;
    checkpointNumber = 0;

    if (getSetting("generateCommitMessages", true)) {
      // This runs from the user's Start command, so VS Code can ask for Copilot
      // permission now instead of interrupting an automatic checkpoint later.
      await chooseCommitMessageModel();
    }

    await runGitInFolder(startingFolder, "switch", "-c", sessionBranch);

    repositoryFolder = startingFolder;
    await createCopilotHooks();
    updateSessionStatus();

    await saveSession();

    startButton.hide();
    finishButton.show();
    vscode.window.showInformationMessage("Copilot session started on a temporary branch.");
  } catch (error) {
    repositoryFolder = undefined;
    originalBranch = undefined;
    sessionBranch = undefined;
    untrackedFiles = [];
    checkpointDetails = {};
    sessionNote = "";
    promptForNextCheckpoint = undefined;
    responseForNextCheckpoint = undefined;
    modelForNextCheckpoint = undefined;
    commitMessageModel = undefined;
    showError(error);
  }
}

async function openSession() {
  const saved = sessionStore.get<SavedSession>(savedSessionKey);
  if (!saved) {
    showStartSessionButton();
    vscode.window.showInformationMessage("No Copilot session is waiting to be reopened.");
    return;
  }

  if (!(await pathExists(saved.repositoryFolder))) {
    await sessionStore.update(savedSessionKey, undefined);
    showStartSessionButton();
    vscode.window.showInformationMessage("The old Copilot session folder no longer exists. You can start a new session.");
    return;
  }

  repositoryFolder = saved.repositoryFolder;
  originalBranch = saved.originalBranch;
  sessionBranch = saved.sessionBranch;
  untrackedFiles = saved.untrackedFiles || [];
  checkpointDetails = saved.checkpointDetails || oldPromptDetails(saved);
  sessionNote = saved.sessionNote || "";
  await runGit("switch", sessionBranch);
  startButton.hide();
  finishButton.show();
  updateSessionStatus();
}

async function chooseCommitMessageModel() {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    const model = models[0];
    if (!model) {
      return;
    }

    // Sending this tiny request from the Start command lets VS Code show its
    // consent dialog now. Later checkpoints happen automatically.
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User("Reply only with: ready")],
      { justification: "Copilot Timeline generates Git commit messages from staged changes." }
    );

    for await (const _ of response.text) {
      break;
    }

    commitMessageModel = model;
  } catch {
    // The session still works if Copilot message generation is unavailable.
    commitMessageModel = undefined;
  }
}

async function createCopilotHooks() {
  if (!repositoryFolder) {
    return;
  }

  const fullHookName = path.join(repositoryFolder, hookFileName);

  await fs.mkdir(path.dirname(fullHookName), { recursive: true });

  // UserPromptSubmit and Stop are the same lifecycle signals that make the
  // Copilot chat input change between its working and idle states.
  const hooks = {
    hooks: {
      UserPromptSubmit: [
        {
          type: "command",
          command: `printf start > ${startMarkerName}`,
          osx: `printf start > ${startMarkerName}`,
          linux: `printf start > ${startMarkerName}`,
          windows: `powershell -NoProfile -Command "Set-Content -Path ${startMarkerName} -Value start"`,
          cwd: "."
        }
      ],
      Stop: [
        {
          type: "command",
          command: `cat > ${stopMarkerName}`,
          osx: `cat > ${stopMarkerName}`,
          linux: `cat > ${stopMarkerName}`,
          windows: `powershell -NoProfile -Command "[Console]::In.ReadToEnd() | Set-Content -NoNewline ${stopMarkerName}"`,
          cwd: "."
        }
      ]
    }
  };

  if (getSetting("capturePrompts", false)) {
    // Hooks receive JSON on stdin. Save that JSON directly; this avoids
    // relying on a separate Node.js executable in the hook environment.
    hooks.hooks.UserPromptSubmit.push({
      type: "command",
      command: `cat > ${detailMarkerName}`,
      osx: `cat > ${detailMarkerName}`,
      linux: `cat > ${detailMarkerName}`,
      windows: `powershell -NoProfile -Command "[Console]::In.ReadToEnd() | Set-Content -NoNewline ${detailMarkerName}"`,
      cwd: "."
    });
  }

  await fs.writeFile(fullHookName, JSON.stringify(hooks, null, 2));
}

function noticeFileChange(uri: vscode.Uri) {
  if (!repositoryFolder) {
    return;
  }

  const relativeName = path.relative(repositoryFolder, uri.fsPath);

  if (relativeName === startMarkerName) {
    void handleCopilotStart();
    return;
  }

  if (relativeName === stopMarkerName) {
    void handleCopilotStop();
    return;
  }

  if (relativeName === detailMarkerName) {
    void handlePromptDetail();
    return;
  }

  noticeRepositoryChange(uri);
}

async function handleCopilotStart() {
  copilotIsWorking = true;
  clearCommitTimer();
  await deleteFileIfItExists(startMarkerName);
}

async function handleCopilotStop() {
  copilotIsWorking = false;
  clearCommitTimer();

  try {
    const stopEvent = JSON.parse(await fs.readFile(path.join(repositoryFolder!, stopMarkerName), "utf8"));
    if (getSetting("captureResponses", true) && typeof stopEvent.transcript_path === "string") {
      const responseDetail = await readFinalResponse(stopEvent.transcript_path);
      responseForNextCheckpoint = responseDetail.response;
      modelForNextCheckpoint = responseDetail.model;
    }
  } catch {
    // Old hook files write only "stop". They still create a checkpoint.
  }
  await deleteFileIfItExists(stopMarkerName);

  // Stop fires once Copilot has finished responding to the prompt.
  commitWork = commitWork.then(createCheckpoint).catch(showError);
}

async function handlePromptDetail() {
  if (!repositoryFolder) {
    return;
  }

  try {
    const detail = JSON.parse(await fs.readFile(path.join(repositoryFolder, detailMarkerName), "utf8"));
    if (typeof detail.prompt === "string" && detail.prompt.trim()) {
      promptForNextCheckpoint = detail.prompt.trim();
    }
  } finally {
    await deleteFileIfItExists(detailMarkerName);
  }
}

async function readFinalResponse(transcriptPath: string): Promise<CheckpointDetail> {
  try {
    const transcript = await fs.readFile(transcriptPath, "utf8");
    let response = "";
    let model = "";

    // The transcript is JSONL and its exact shape is still preview-only. Look
    // for the last assistant-shaped entry and keep its readable text.
    for (const line of transcript.split("\n")) {
      try {
        const entry = JSON.parse(line);
        model = model || transcriptModel(entry);
        const role = String(entry.role || entry.type || entry.kind || entry.message?.role || "").toLowerCase();
        if (role.includes("assistant") || role.includes("agent")) {
          const text = transcriptText(entry.message?.content ?? entry.content ?? entry.message?.text ?? entry.text);
          if (text) {
            response = text;
          }
        }
      } catch {
        // A malformed line should not stop the session checkpoint.
      }
    }
    return { response: response.slice(0, 8000) || undefined, model: model || undefined };
  } catch {
    return {};
  }
}

// The transcript format is preview-only, so accept a few common model field
// names instead of assuming one fixed JSON shape.
function transcriptModel(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const item = value as Record<string, unknown>;
  for (const key of ["model", "modelId", "modelName"]) {
    if (typeof item[key] === "string" && item[key].trim()) {
      return item[key].trim();
    }
  }
  for (const child of Object.values(item)) {
    const model = transcriptModel(child);
    if (model) {
      return model;
    }
  }
  return "";
}

function transcriptText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(transcriptText).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (typeof item.text === "string") {
      return item.text;
    }
    return Object.values(item).map(transcriptText).filter(Boolean).join("\n");
  }
  return "";
}

function noticeRepositoryChange(uri: vscode.Uri) {
  if (
    !repositoryFolder ||
    !sessionBranch ||
    finishing ||
    copilotIsWorking
  ) {
    return;
  }

  // Git changes its own files whenever we commit. Ignore those changes so that
  // a checkpoint does not accidentally cause another checkpoint.
  const relativeName = path.relative(repositoryFolder, uri.fsPath);
  if (
    relativeName === hookFileName ||
    relativeName === startMarkerName ||
    relativeName === stopMarkerName ||
    relativeName === detailMarkerName ||
    relativeName === ".git" ||
    relativeName.startsWith(`.git${path.sep}`)
  ) {
    return;
  }

  // Restart the timer for every file change. Copilot often edits several files
  // in quick succession, and we want those edits in a single commit.
  if (commitTimer) {
    clearTimeout(commitTimer);
  }

  commitTimer = setTimeout(() => {
    // Put commits in a small queue so two Git commands never run at once.
    commitWork = commitWork.then(createCheckpoint).catch(showError);
  }, 5000);
}

async function createCheckpoint() {
  if (!sessionBranch) {
    return;
  }

  // Add new, changed, and deleted files to the Git staging area.
  await runGit("add", "-A");

  // The hook and files that existed untracked before Start are not session
  // changes, so remove them from the staging area before every checkpoint.
  const filesToExclude: string[] = [];
  for (const file of [hookFileName, detailMarkerName, ...untrackedFiles]) {
    if (await pathExists(path.join(repositoryFolder!, file))) {
      filesToExclude.push(file);
    }
  }
  if (filesToExclude.length) {
    await runGit("reset", "--", ...filesToExclude);
  }

  // Git cannot create a normal commit when there is nothing staged.
  const stagedFiles = await runGit("diff", "--cached", "--name-only");
  if (!stagedFiles) {
    promptForNextCheckpoint = undefined;
    responseForNextCheckpoint = undefined;
    modelForNextCheckpoint = undefined;
    return;
  }

  checkpointNumber += 1;
  const fallback = `Copilot checkpoint ${checkpointNumber}`;
  await runGit("commit", "-m", await generateCommitMessage(fallback));
  const commitHash = await runGit("rev-parse", "HEAD");
  if (promptForNextCheckpoint || responseForNextCheckpoint || modelForNextCheckpoint) {
    checkpointDetails[commitHash] = {
      prompt: promptForNextCheckpoint,
      response: responseForNextCheckpoint,
      model: modelForNextCheckpoint
    };
    promptForNextCheckpoint = undefined;
    responseForNextCheckpoint = undefined;
    modelForNextCheckpoint = undefined;
    await saveSession();
  }
  updateSessionStatus();
}

async function finishSession() {
  if (!repositoryFolder || !originalBranch || !sessionBranch) {
    vscode.window.showInformationMessage("No Copilot session is running.");
    return;
  }
  if (finishing) {
    return;
  }

  finishing = true;
  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = undefined;
  }

  try {
    // Wait for an automatic checkpoint, then capture any final saved changes.
    await commitWork;
    await deleteFileIfItExists(hookFileName);
    await deleteFileIfItExists(startMarkerName);
    await deleteFileIfItExists(stopMarkerName);
    await deleteFileIfItExists(detailMarkerName);
    await createCheckpoint();

    const sessionCommits = await runGit("log", "--oneline", `${originalBranch}..${sessionBranch}`);
    if (!sessionCommits) {
      await runGit("switch", originalBranch);
      if (getSetting("deleteBranchWhenFinished", true)) {
        await runGit("branch", "-D", sessionBranch);
      }
      await endSession();
      vscode.window.showInformationMessage("Copilot session finished with no changes.");
    } else {
      await showSessionSummary();
    }
  } catch (error) {
    finishing = false;
    showError(error);
  }
}

async function showSessionSummary() {
  if (!originalBranch || !sessionBranch) {
    return;
  }

  // The commits are already the timeline, so there is no extra history file.
  const log = await runGit(
    "log",
    "--format=%H%x1f%s%x1f%ct%x1e",
    `${originalBranch}..${sessionBranch}`
  );
  const commits = await Promise.all(
    log.split("\x1e").filter(Boolean).map(async (line) => {
      const [rawHash, subject, timestamp] = line.split("\x1f");
      // Git puts a newline between log entries. Remove it before passing the
      // commit hash back to Git.
      const hash = rawHash.trim();
      const [files, diff, numbers] = await Promise.all([
        runGit("show", "--format=", "--name-only", hash),
        runGit("show", "--format=", "--no-ext-diff", hash),
        runGit("show", "--format=", "--numstat", hash)
      ]);
      const change = numbers.split("\n").reduce((total, line) => {
        const [added, deleted] = line.split("\t");
        total.added += Number(added) || 0;
        total.deleted += Number(deleted) || 0;
        return total;
      }, { added: 0, deleted: 0 });
      return {
        hash,
        subject,
        time: new Date(Number(timestamp) * 1000).toLocaleString(),
        files: files.split("\n").filter(Boolean),
        diff,
        change,
        detail: checkpointDetails[hash]
      };
    })
  );

  const panel = vscode.window.createWebviewPanel(
    "copilotTimelineSummary",
    "Copilot Timeline Session",
    vscode.ViewColumn.Active,
    { enableScripts: true }
  );

  const changedFileCount = new Set(commits.flatMap((commit) => commit.files)).size;
  const promptCount = commits.filter((commit) => commit.detail?.prompt).length;
  const responseCount = commits.filter((commit) => commit.detail?.response).length;

  const stats = [
    [commits.length, "checkpoints"],
    [changedFileCount, "files changed"],
    [promptCount, "prompts"],
    [responseCount, "responses"]
  ].map(([count, label]) => `<div class="stat"><strong>${count}</strong><span>${label}</span></div>`).join("");
  const rows = commits.map((commit, index) => `<tbody>
    <tr class="commit-row" onclick="toggleDiff(${index})">
      <td class="graph"><span class="node"></span></td><td><div class="subject"><button class="star ${commit.detail?.important ? "important" : ""}" title="${commit.detail?.important ? "Marked important" : "Mark as important"}" onclick="toggleImportant(event, this, ${index})">${commit.detail?.important ? "★" : "☆"}</button>${escapeHtml(commit.subject)}</div><div class="hint"><span class="added">+${commit.change.added}</span> / <span class="deleted">-${commit.change.deleted}</span> · Click to inspect checkpoint diff</div></td>
      <td><div class="files">${commit.files.map((file) => `<span class="file">${escapeHtml(file)}</span>`).join("")}</div></td>
      <td class="time">${escapeHtml(commit.time)}</td><td class="hash">${escapeHtml(commit.hash.slice(0, 7))}</td>
      <td class="prompt">${commit.detail?.prompt ? `<button class="prompt-icon" data-detail="${escapeHtml(commit.detail.prompt)}" data-title="Original Copilot prompt" onmouseenter="previewDetail(event, this)" onmouseleave="hidePrompt()" onclick="pinDetail(event, this)">☷</button>` : `<span class="not-captured">—</span>`}</td>
      <td class="prompt">${commit.detail?.response ? `<button class="prompt-icon response-icon" data-detail="${escapeHtml(commit.detail.response)}" data-title="Copilot response${commit.detail.model ? ` · ${escapeHtml(commit.detail.model)}` : ""}" onmouseenter="previewDetail(event, this)" onmouseleave="hidePrompt()" onclick="pinDetail(event, this)">✦</button>${commit.detail.model ? `<span class="model" title="${escapeHtml(commit.detail.model)}">${escapeHtml(commit.detail.model)}</span>` : ""}` : `<span class="not-captured">—</span>`}</td>
    </tr>
    <tr class="diff-row" id="diff-${index}" hidden><td colspan="7" class="diff-cell"><div class="diff-label">Checkpoint ${index + 1} diff</div><div class="diff">${formatDiff(commit.diff)}</div></td></tr>
  </tbody>`).join("");
  panel.webview.html = await loadWebviewTemplate("session-summary.html", {
    STATS: stats,
    SESSION_NOTE: escapeHtml(sessionNote),
    ROWS: rows
  });

  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.action === "saveNote") {
        sessionNote = typeof message.note === "string" ? message.note.trim().slice(0, 1000) : "";
        await saveSession();
        vscode.window.showInformationMessage("Copilot session note saved.");
      }
      if (message.action === "important" && typeof message.index === "number") {
        const commit = commits[message.index];
        if (commit) {
          const detail = checkpointDetails[commit.hash] || {};
          detail.important = !detail.important;
          checkpointDetails[commit.hash] = detail;
          await saveSession();
        }
      }
      if (message.action === "keep") {
        await keepSession();
        panel.dispose();
      }
      if (message.action === "compare") {
        await showFullComparison();
      }
      if (message.action === "discard") {
        const answer = await vscode.window.showWarningMessage(
          "Discard this Copilot session branch? Existing untracked files will stay on disk.",
          { modal: true },
          "Discard"
        );
        if (answer === "Discard") {
          await discardSession();
          panel.dispose();
          vscode.window.showInformationMessage("Copilot session discarded.");
        }
      }
    } catch (error) {
      showError(error);
    }
  });

  // Closing the review tab does not throw away the session. Finish can open it
  // again when the user is ready to decide.
  panel.onDidDispose(() => {
    if (sessionBranch) {
      finishing = false;
    }
  });
}

async function keepSession() {
  if (!originalBranch || !sessionBranch) {
    return;
  }

  const currentBranch = await runGit("branch", "--show-current");
  if (currentBranch !== sessionBranch || await hasTrackedChanges(repositoryFolder!)) {
    throw new Error("The session has uncommitted tracked changes, so it was not merged.");
  }

  await runGit("switch", originalBranch);
  await runGit("merge", "--squash", sessionBranch);
  const filesToCommit = await runGit("diff", "--cached", "--name-only");
  if (filesToCommit) {
    // A squash merge removes the individual checkpoint commits, so put the
    // user's important markers in the final Git commit where they last.
    const importantCheckpoints = await getImportantCheckpoints();
    const commitParts = ["Copilot session"];
    if (sessionNote) {
      commitParts.push(sessionNote);
    }
    if (importantCheckpoints) {
      commitParts.push(`Important checkpoints:\n${importantCheckpoints}`);
    }
    const commitArgs = ["commit", ...commitParts.flatMap((part) => ["-m", part])];
    await runGit(...commitArgs);
    vscode.window.showInformationMessage("Copilot session merged into your original branch.");
  } else {
    vscode.window.showInformationMessage("Copilot session had no final changes to merge.");
  }
  if (getSetting("deleteBranchWhenFinished", true)) {
    await runGit("branch", "-D", sessionBranch);
  }
  await endSession();
}

async function getImportantCheckpoints() {
  const importantHashes = Object.entries(checkpointDetails)
    .filter(([, detail]) => detail.important)
    .map(([hash]) => hash);
  const lines = await Promise.all(importantHashes.map(async (hash) => {
    const subject = await runGit("show", "-s", "--format=%s", hash);
    return `- ${subject} (${hash.slice(0, 7)})`;
  }));
  return lines.join("\n");
}

async function discardSession() {
  if (!originalBranch || !sessionBranch) {
    return;
  }

  // Switching branches removes the committed session files, while existing
  // untracked files stay exactly where they are.
  await runGit("switch", originalBranch);
  await runGit("branch", "-D", sessionBranch);
  await endSession();
}

async function showFullComparison() {
  if (!originalBranch || !sessionBranch) {
    return;
  }

  // This is the net change from the session's starting commit to its final
  // commit. It deliberately does not show the individual checkpoints.
  const diff = await runGit("diff", "--no-ext-diff", `${originalBranch}...${sessionBranch}`);
  const panel = vscode.window.createWebviewPanel(
    "copilotTimelineComparison",
    "Copilot Session: Full Comparison",
    vscode.ViewColumn.Active,
    { enableScripts: false }
  );

  panel.webview.html = `<!doctype html>
<html><head><style>
  body { background:var(--vscode-editor-background); color:var(--vscode-foreground); font-family:var(--vscode-font-family); font-size:12px; margin:0; }
  main { margin:0 auto; max-width:1200px; padding:22px 26px 32px; }
  h1 { font-size:16px; font-weight:650; margin:0 0 5px; }
  .subtitle { color:var(--vscode-descriptionForeground); margin:0 0 16px; }
  .states { align-items:center; display:flex; gap:8px; margin-bottom:14px; }
  .state { background:var(--vscode-editorWidget-background); border:1px solid var(--vscode-widget-border); border-radius:5px; min-width:180px; padding:8px 10px; }
  .arrow { color:var(--vscode-textLink-foreground); font-size:18px; }
  .label { color:var(--vscode-descriptionForeground); font-size:10px; font-weight:650; letter-spacing:.4px; text-transform:uppercase; }
  code { font-family:var(--vscode-editor-font-family); font-size:11px; }
  .diff { border:1px solid var(--vscode-widget-border); border-radius:6px; box-sizing:border-box; font-family:var(--vscode-editor-font-family); font-size:12px; line-height:19px; max-height:calc(100vh - 158px); overflow:auto; white-space:pre; }
  .line { display:block; min-height:19px; padding:0 12px; }
  .addition { background:var(--vscode-diffEditor-insertedLineBackground); }
  .deletion { background:var(--vscode-diffEditor-removedLineBackground); }
  .hunk { background:var(--vscode-textBlockQuote-background); color:var(--vscode-textLink-foreground); }
  .meta { color:var(--vscode-descriptionForeground); }
</style></head><body><main>
  <h1>Full comparison</h1><p class="subtitle">The final session result compared with the branch where the session began.</p>
  <div class="states">
    <div class="state"><div class="label">Initial state</div><code>${escapeHtml(originalBranch)}</code></div>
    <div class="arrow">→</div>
    <div class="state"><div class="label">Final state</div><code>${escapeHtml(sessionBranch)}</code></div>
  </div>
  <div class="diff">${formatDiff(diff)}</div>
</main></body></html>`;
}

async function endSession() {
  repositoryFolder = undefined;
  originalBranch = undefined;
  sessionBranch = undefined;
  untrackedFiles = [];
  checkpointDetails = {};
  sessionNote = "";
  promptForNextCheckpoint = undefined;
  responseForNextCheckpoint = undefined;
  modelForNextCheckpoint = undefined;
  finishing = false;
  copilotIsWorking = false;
  commitMessageModel = undefined;
  await sessionStore.update(savedSessionKey, undefined);
  finishButton.hide();
  sessionStatus.hide();
  showStartSessionButton();
}

async function saveSession() {
  if (!repositoryFolder || !originalBranch || !sessionBranch) {
    return;
  }
  await sessionStore.update(savedSessionKey, {
    repositoryFolder,
    originalBranch,
    sessionBranch,
    untrackedFiles,
    checkpointDetails,
    sessionNote
  });
}

function showStartSessionButton() {
  startButton.text = "$(play) Start Copilot Session";
  startButton.command = "copilotTimeline.start";
  startButton.tooltip = "Create a branch and start making Copilot checkpoints";
  startButton.show();
}

function showOpenSessionButton() {
  startButton.text = "$(window) Open Copilot Session";
  startButton.command = "copilotTimeline.open";
  startButton.tooltip = "Reopen the active Copilot session window";
  startButton.show();
}

function updateSessionStatus() {
  if (!sessionBranch) {
    sessionStatus.hide();
    return;
  }
  sessionStatus.text = `$(git-commit) Copilot session • ${checkpointNumber} checkpoint${checkpointNumber === 1 ? "" : "s"}`;
  sessionStatus.tooltip = "Copilot Timeline Session is recording Git checkpoints";
  sessionStatus.show();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>\"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;"
  }[character]!));
}

function formatDiff(diff: string) {
  return diff.split("\n").map((line) => {
    const safeLine = escapeHtml(line) || "&nbsp;";
    let style = "";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      style = "addition";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      style = "deletion";
    } else if (line.startsWith("@@")) {
      style = "hunk";
    } else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++ ") || line.startsWith("--- ")) {
      style = "meta";
    }
    return `<span class="line ${style}">${safeLine}</span>`;
  }).join("");
}

async function generateCommitMessage(fallback: string) {
  if (!getSetting("generateCommitMessages", true) || !commitMessageModel) {
    return fallback;
  }

  try {
    // Ask Copilot about exactly what Git has staged for this commit.
    const diff = await runGit("diff", "--cached", "--no-ext-diff", "--unified=0");
    if (!diff.trim()) {
      return fallback;
    }

    const response = await commitMessageModel.sendRequest(
      [
        vscode.LanguageModelChatMessage.User(
          "Write one short Git commit subject for this diff. Use imperative mood. " +
          "Return only the subject, with no quotes or explanation.\n\n" +
          diff.slice(0, 12000)
        )
      ]
    );

    let message = "";
    for await (const part of response.text) {
      message += part;
    }

    // A Git subject is one line. Keep a safe fallback if Copilot returns an
    // empty answer or asks a question instead of writing a commit subject.
    const subject = message.trim().split("\n")[0].replace(/^["'`]|["'`]$/g, "").slice(0, 72);
    if (!subject || /share.*diff|need.*diff|please provide/i.test(subject)) {
      return fallback;
    }
    return subject;
  } catch {
    // A missing model, rejected permission, or quota limit must not stop a commit.
    return fallback;
  }
}

function getSetting<T>(name: string, defaultValue: T) {
  return vscode.workspace.getConfiguration("copilotTimeline").get<T>(name, defaultValue);
}

async function loadWebviewTemplate(name: string, values: Record<string, string>) {
  const template = await fs.readFile(path.join(extensionFolder, "media", name), "utf8");
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] || "");
}

function clearCommitTimer() {
  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = undefined;
  }
}

async function deleteFileIfItExists(relativeName: string) {
  if (!repositoryFolder) {
    return;
  }

  try {
    await fs.unlink(path.join(repositoryFolder, relativeName));
  } catch (error) {
    // Missing files are fine. Anything else is a real problem worth showing.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function pathExists(fullName: string) {
  try {
    await fs.access(fullName);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepository(folder: string) {
  try {
    return (await runGitInFolder(folder, "rev-parse", "--is-inside-work-tree")) === "true";
  } catch {
    return false;
  }
}

async function getCurrentBranch(folder: string) {
  try {
    return await runGitInFolder(folder, "branch", "--show-current");
  } catch {
    return undefined;
  }
}

async function hasTrackedChanges(folder: string) {
  const status = await runGitInFolder(folder, "status", "--porcelain");
  return status.split("\n").some((line) => line && !line.startsWith("??") && !line.startsWith("!!"));
}

async function getUntrackedFiles(folder: string) {
  const files = await runGitInFolder(folder, "ls-files", "--others", "--exclude-standard");
  return files.split("\n").filter(Boolean);
}

function makeSessionBranchName() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    twoDigits(now.getMonth() + 1),
    twoDigits(now.getDate())
  ].join("");
  const time = `${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}`;
  return `copilot/session-${date}-${time}`;
}

function twoDigits(number: number) {
  return String(number).padStart(2, "0");
}

async function runGit(...argumentsForGit: string[]) {
  if (!repositoryFolder) {
    throw new Error("No repository folder is open.");
  }
  return runGitInFolder(repositoryFolder, ...argumentsForGit);
}

async function runGitInFolder(folder: string, ...argumentsForGit: string[]) {
  const result = await execFileAsync("git", argumentsForGit, { cwd: folder });
  return result.stdout.trim();
}

function showError(error: unknown) {
  const commandError = error as NodeJS.ErrnoException & {
    stderr?: string;
    stdout?: string;
  };
  const message = error instanceof Error ? error.message : String(error);
  // Git sometimes prints useful failures, including "nothing to commit", to
  // stdout instead of stderr.
  const details = commandError.stderr?.trim() || commandError.stdout?.trim();
  vscode.window.showErrorMessage(
    `Copilot Timeline Session: ${details || message}`
  );
}

export function deactivate() {
  clearCommitTimer();
}
