# Copilot Timeline Session

Copilot Timeline Session turns GitHub Copilot agent work into Git checkpoints,
reviewable diffs, and one final squash commit.

**Website:** [mmcs-work.github.io/copilot-timeline-session](https://mmcs-work.github.io/copilot-timeline-session/)

## How it works

1. Make sure the repository has at least one commit.
2. Run **Start Copilot Session** from the status bar or Command Palette.
3. Use GitHub Copilot normally.
4. Run **Finish Copilot Session** when you are done.

Starting creates a branch such as:

```text
copilot/session-20260725-1430
```

The session runs in the same project folder. Existing untracked and ignored
files, such as `.env`, stay on disk and are never included in its commits.
New non-ignored files created during the session are included normally.

For safety, Start asks you to commit or stash any existing changes to tracked
files. Existing untracked files are fine.

The extension temporarily creates `.github/hooks/copilot-timeline.json`. Its
`Stop` hook runs when Copilot finishes responding to a prompt, which creates
`Copilot checkpoint 1`, `Copilot checkpoint 2`, and so on. The hook file is
removed before the session is merged and is never included in a commit.

When a session starts, VS Code may ask permission for Copilot Timeline to use
your Copilot model. If you allow it, the extension generates a short commit
message from the staged diff for each checkpoint and final session commit. If
Copilot is unavailable, it uses the simple fallback messages instead.

## Settings

Search **Copilot Timeline Session** in VS Code Settings to change these options:

- **Delete Branch When Finished** (default: on) removes the temporary session
  branch after a successful Keep.
- **Generate Commit Messages** (default: on) uses Copilot to create short
  commit messages. Turn it off to use `Copilot checkpoint 1` and
  `Copilot session` instead.
- **Capture Prompts** (default: on) keeps the submitted Copilot prompt with
  each checkpoint so it can be shown when you hover over the prompt icon in the
  review table. Turn this on only if those prompts are safe to store locally.
- **Capture Responses** (default: on) tries to keep Copilot's final reply with
  each checkpoint. It appears behind the green response icon in the review
  table. When VS Code provides it, the model name appears underneath the icon.
  Turn this on only if those replies are safe to store locally.

After Copilot has stopped, repository changes use a five-second quiet period.
This catches actions such as **Copilot Undo**, which happen after the response
has already finished.

Finishing commits remaining changes and opens a small review screen. It lists
each checkpoint and its changed files. Choose **Keep all** to squash-merge it
into the original branch, **Open comparison** to see the complete diff, or
**Discard session** to return to the original branch and delete the temporary
session branch. Existing untracked files stay on disk in every case. In the
review screen, use the star to mark an important checkpoint, read its compact
`+added / -deleted` change size, and optionally save a session note. The note
and any starred checkpoints are added to the final squash commit when you
choose Keep all.

## Important limitation

Agent Hooks are currently a VS Code preview feature, so this project requires
VS Code 1.129 or newer. The `Stop` hook accurately follows Copilot agent
responses. Response capture reads VS Code's preview transcript, so a response
can be unavailable if VS Code changes that transcript format. The five-second
fallback used for Undo cannot tell a Copilot Undo
from a manual edit made while Copilot is idle, so an idle manual edit can also
become a checkpoint.

The minimum session details are stored by VS Code so the extension can continue
after a reload. When capture is enabled, prompts and available responses are
also stored locally for the active session and removed when the session ends.

## Run it

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to start an Extension Development
Host.

The whole implementation is in `extension.ts`.

## Install a packaged extension

1. Download the latest `.vsix` file from the GitHub release.
2. In VS Code, open the Command Palette with `Cmd+Shift+P`.
3. Run **Extensions: Install from VSIX...** and select the file.
4. Reload VS Code when it asks.

## Website and GitHub Pages

The landing page lives in `docs/index.html`. The workflow in
`.github/workflows/deploy-pages.yml` publishes it automatically whenever you
push to `main` or `master`.

The site is published at
`https://mmcs-work.github.io/copilot-timeline-session/` after GitHub Pages is
enabled for the repository. Choose a license before publishing to the VS Code
Marketplace.

## Create a GitHub Release

Push a Git tag that matches the extension version, for example `v0.3.11`. The
release workflow builds the VSIX, creates a GitHub Release, and attaches the
installable file automatically.

## Acknowledgements

Built with assistance from OpenAI Codex.
