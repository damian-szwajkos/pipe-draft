# PipeDraft

Dry-run Jenkins pipelines in the browser. Paste a Jenkinsfile and see which stages run, when, and why, for every kind of build: a push to `main`, a pull request, a tag, a nightly cron run, or a run where a command fails. Nothing is executed and nothing leaves the browser. Built alongside [ArchDraft](https://damian-szwajkos.github.io/arch-draft/), CloudDraft and KubeDraft.

**Live:** https://damian-szwajkos.github.io/pipe-draft/ · [Playground](https://damian-szwajkos.github.io/pipe-draft/play.html)

## Run

```bash
python3 serve.py 5188      # or any static server
npm test                   # engine tests (Node 20+)
node tests/smoke.mjs       # print every example × context outcome
```

Then open http://localhost:5188 for the landing page, or http://localhost:5188/play.html for the playground. There is no build step and there are no dependencies.

## What it does

- **Live checks, runs on demand.** Syntax and structure are checked as you type. A run simulates every context at once, and only when you press **Run** (or <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd>). The active context is then played back: stages light up as the simulated clock reaches them, parallel branches run side by side, and the console log streams in. <kbd>Esc</kbd> skips to the result. After an edit, the previous results are marked as stale until you run again. Switch on **Auto-run** to run after every change instead.

- **Syntax and structure checks.** A Groovy-subset parser reports compile errors (unclosed blocks and strings, stray tokens) at the exact position. The declarative checks mirror Jenkins' validator: missing `agent`/`stages`, steps outside `steps { }`, Groovy code that needs `script { }`, unknown `when` conditions, `post` conditions and agent types, duplicate stage names, environment values, cron specs and matrix axes. Lints flag an `input` step that holds an executor, a `when` without `beforeAgent`, a missing global timeout, and secrets interpolated into `sh`.
- **Run contexts.** Each context describes one build: branch, pull request or tag, the build cause, changed files, commit messages, parameters, the previous result, the input decision and mock rules. The multibranch environment is set the way Jenkins sets it, for example `BRANCH_NAME = PR-42` on pull requests and the tag name on tag builds.
- **Mocks.** Every command succeeds. git commands return plausible output (`rev-parse`, `describe`, `diff --name-only`, `log`). A mock rule (text or `/regex/`, exit code, stdout, first N calls only) makes `sh`, `junit`, `build`, `httpRequest`, `readFile` or an unknown plugin step fail or return output.
- **Engine.** Declarative semantics: the `when` evaluation order (`beforeOptions`/`beforeInput`/`beforeAgent`), "skipped due to earlier failure(s)", `skipStagesAfterUnstable`, parallel branches and `failFast`, matrix cells with excludes, stage `options { retry; timeout }`, `post` condition order and `changed`/`fixed`/`regression`, `catchError`, `warnError`, `unstable`, `input` and `credentials()`. Scripted pipelines run through the same interpreter (`node`, `stage`, `parallel`, if/for/try, methods), and each stage that never ran says why (for example "if (…) was false").
- **Views.** A stage graph, details for each stage (its conditions, the `when` tree evaluated for this context, evaluation order, steps, post), a condition matrix of stages × contexts, a Jenkins-style console log, and line coverage in the editor gutter.

## Layout

| Path | Role |
|---|---|
| `src/engine/lexer.js`, `parser.js` | Groovy-subset tokenizer and parser (GStrings, closures, command expressions, slashy regex) |
| `src/engine/model.js`, `catalog.js` | Declarative model, structure checks, lints, static stage tree for scripted pipelines |
| `src/engine/conditions.js` | `when` conditions: static description and runtime evaluation with explanations |
| `src/engine/interp.js` | Groovy interpreter (collections, closures, exceptions, String/List/Map methods) |
| `src/engine/engine.js` | `analyze()` and `simulate()`: run model, mocked steps, globals (`env`, `params`, `currentBuild`, `docker`) |
| `src/engine/contexts.js` | Run contexts, the environment and build causes, preset and suggested contexts |
| `play.html`, `styles.css`, `src/ui/` | Playground: editor, SVG stage graph with playback, app wiring (`?example=<id>` opens an example, `?embed=1` is used by the landing page) |
| `index.html`, `site.css`, `src/site/landing.js` | Landing page (shares its look with KubeDraft) |
| `src/examples.js` | Example Jenkinsfiles with their own contexts |

## Limits

- This is a model of Jenkins, not Jenkins. Shared libraries are not loaded: their steps are mocked. Plugin steps the simulator doesn't know succeed as no-ops and are flagged.
- The Groovy subset covers what Jenkinsfiles use day to day. It does not support classes, metaprogramming or `@NonCPS` semantics.
- Durations are estimates. They exist so that `timeout`, `failFast` and the timeline behave plausibly.
