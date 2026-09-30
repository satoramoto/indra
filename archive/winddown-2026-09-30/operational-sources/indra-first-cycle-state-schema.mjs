import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "node:fs";
//#region src/build-stamp.ts
/** The stamp of the build in `dir` (a `builds/<name>` directory or `dist`), or undefined without a valid one. */
async function readStampIn(dir) {
	try {
		const stamp = JSON.parse(await readFile(join(dir, "build-stamp.json"), "utf8"));
		return typeof stamp.id === "string" && stamp.id ? {
			id: stamp.id,
			sha: typeof stamp.sha === "string" ? stamp.sha : "",
			builtAt: typeof stamp.builtAt === "string" ? stamp.builtAt : ""
		} : void 0;
	} catch {
		return;
	}
}
promisify(execFile);
/** The token the owner may supply for fetching from and pushing to the state repository. */
var STATE_TOKEN_VARIABLE = "INDRA_STATE_GITHUB_TOKEN";
/** Every variable no child process inherits by default. */
var CAPTURED_VARIABLE = new RegExp(`^(?:OP_|${STATE_TOKEN_VARIABLE}$)`);
var captured = {};
/** The GitHub token the owner supplied as `INDRA_STATE_GITHUB_TOKEN` when starting Indra, if any; only state-repository git uses it. */
function stateRepoToken() {
	return captured["INDRA_STATE_GITHUB_TOKEN"]?.trim() || void 0;
}
/** A copy of `env` without any `OP_*` variable or the state repository token, for every child process that is not `op`. */
function childEnv(env = process.env) {
	return Object.fromEntries(Object.entries(env).filter(([name]) => !CAPTURED_VARIABLE.test(name)));
}
//#endregion
//#region src/reload.ts
/**
* The Indra checkout a module runs from. Node resolves the `dist` symlink, so a built module's own path is
* `builds/<build>/x.js` after a self-update, `dist/x.js` after a local `npm run build`, or `src/x.ts` in tests.
*/
function appRootOf(moduleUrl) {
	const dir = dirname(fileURLToPath(moduleUrl));
	return basename(dirname(dir)) === "builds" ? resolve(dir, "..", "..") : resolve(dir, "..");
}
//#endregion
//#region src/state-commit.ts
/** A state write that could not be committed, or a checkout Indra must not commit in. */
var StateCommitError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = "StateCommitError";
	}
};
var gitEnv = () => ({
	...childEnv(),
	GIT_TERMINAL_PROMPT: "0"
});
/** The `-c` options that make one git process authenticate with the state token, and only to the state repository. */
var STATE_CREDENTIAL_CONFIG = [
	"-c",
	"credential.helper=",
	"-c",
	`credential.helper=${`!f() { test "\$1" = get || { cat >/dev/null; exit 0; }; p=; h=; u=; while IFS= read -r line; do case "\$line" in protocol=*) p="\${line#protocol=}";; host=*) h="\${line#host=}";; path=*) u="\${line#path=}";; esac; done; test "\$p" = https && test "\$h" = github.com || exit 0; case "\$u" in satoramoto/indra-state|satoramoto/indra-state.git) ;; *) exit 0;; esac; echo username=x-access-token; echo "password=$${STATE_TOKEN_VARIABLE}"; }; f`}`,
	"-c",
	"credential.useHttpPath=true"
];
/**
* The git arguments and environment for one command in the state checkout. Fetches and pushes authenticate with
* the owner's `INDRA_STATE_GITHUB_TOKEN` when it was supplied; every other command, and every command without
* the token, runs as before with the ambient credentials.
*/
function gitInvocation(checkout, args) {
	const token = stateRepoToken();
	if (!token || args[0] !== "fetch" && args[0] !== "push") return {
		args: [
			"-C",
			checkout,
			...args
		],
		env: gitEnv()
	};
	return {
		args: [
			"-C",
			checkout,
			...STATE_CREDENTIAL_CONFIG,
			...args
		],
		env: {
			...gitEnv(),
			[STATE_TOKEN_VARIABLE]: token
		},
		token
	};
}
/** `text` with every occurrence of `token` removed, for messages that might echo what git saw. */
var withoutToken = (text, token) => token ? text.split(token).join("[redacted]") : text;
function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}
var code = (error) => error.code;
/** Moves a dead holder's lock aside; restores it if a live holder replaced it in the meantime. */
async function breakStale(file, holder) {
	const aside = `${file}.${randomUUID()}.stale`;
	try {
		await rename(file, aside);
	} catch (error) {
		if (code(error) === "ENOENT") return;
		throw error;
	}
	if (await readFile(aside, "utf8").catch(() => holder) !== holder) await link(aside, file).catch(() => void 0);
	await unlink(aside).catch(() => void 0);
}
/**
* Runs `work` while holding an exclusive lock file shared by every Indra process on this machine.
* A lock left by a process that no longer exists is broken; a live holder is waited for.
*/
async function withFileLock(file, work, timeoutMs = 12e4) {
	await mkdir(dirname(file), {
		recursive: true,
		mode: 448
	});
	const token = `${process.pid} ${randomUUID()}`;
	const deadline = Date.now() + timeoutMs;
	while (true) {
		try {
			await writeFile(file, token, {
				flag: "wx",
				mode: 384
			});
			break;
		} catch (error) {
			if (code(error) !== "EEXIST") throw error;
		}
		const holder = await readFile(file, "utf8").catch(() => void 0);
		if (holder !== void 0 && !alive(Number(holder.split(" ")[0]))) {
			await breakStale(file, holder);
			continue;
		}
		if (Date.now() > deadline) throw new StateCommitError(`Timed out waiting for the state lock ${file} (held by process ${holder?.split(" ")[0] ?? "unknown"}).`);
		await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
	}
	try {
		return await work();
	} finally {
		if (await readFile(file, "utf8").catch(() => void 0) === token) await unlink(file).catch(() => void 0);
	}
}
/** Git operations on the state checkout. Only `path` (`state.json` unless given) is ever committed. */
var StateGit = class {
	checkout;
	path;
	constructor(checkout, path = "state.json") {
		this.checkout = checkout;
		this.path = path;
	}
	run(args) {
		const invocation = gitInvocation(this.checkout, args);
		return new Promise((resolve, reject) => {
			execFile("git", invocation.args, {
				encoding: "utf8",
				env: invocation.env,
				timeout: 6e4
			}, (error, stdout, stderr) => {
				if (error) reject(new StateCommitError(withoutToken(`git ${args[0]} failed in ${this.checkout}: ${(stderr || error.message).trim()}`, invocation.token), invocation.token ? void 0 : { cause: error }));
				else resolve(stdout);
			});
		});
	}
	/** True when the file differs from HEAD in the index or the working tree, or is untracked. */
	async dirty() {
		return (await this.run([
			"--no-optional-locks",
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--",
			this.path
		])).trim() !== "";
	}
	async assertClean() {
		if (await this.dirty()) throw new StateCommitError(`${this.path} in ${this.checkout} has changes that are not committed. Indra commits its own state changes and will not commit these; commit or discard them, then retry.`);
	}
	/** Commits only the state file, whatever else is staged. */
	async commit(message) {
		await this.run([
			"commit",
			"--quiet",
			"--only",
			"-m",
			message,
			"--",
			this.path
		]);
	}
	/** The subject of the last commit that changed the file, or "" when none did. */
	async lastSubject() {
		return (await this.run([
			"log",
			"-1",
			"--format=%s",
			"--",
			this.path
		])).trim();
	}
	/** Stages the file, so a file git does not track yet can be committed with `commit`. */
	async add() {
		await this.run([
			"add",
			"--",
			this.path
		]);
	}
	async unstage() {
		await this.run([
			"reset",
			"--quiet",
			"--",
			this.path
		]).catch(() => void 0);
	}
	/**
	* Brings the checkout up to date with its upstream branch; the caller holds the state lock.
	* Fetches, then fast-forwards, or rebases local commits onto the upstream, then pushes what is
	* still unpushed. It never force-pushes and never drops a commit: a conflict aborts the rebase and
	* leaves the checkout exactly as it was, and every problem becomes the result instead of an error.
	*/
	async sync() {
		const at = (/* @__PURE__ */ new Date()).toISOString();
		const result = (outcome, message, changed = false) => ({
			outcome,
			message,
			changed,
			at
		});
		const detail = (error) => (error instanceof Error ? error.message : String(error)).split("\n")[0];
		try {
			const upstream = (await this.run([
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{upstream}"
			]).catch(() => "")).trim();
			if (!upstream) return result("skipped", "The state checkout's branch has no upstream to sync with.");
			if (await this.busy()) return result("dirty", "The state checkout has uncommitted changes or an unfinished rebase or merge; commit or discard them to resume syncing.");
			try {
				await this.run(["fetch", "--quiet"]);
			} catch (error) {
				return result("offline", `Could not fetch ${upstream}: ${detail(error)}`);
			}
			const before = (await this.run(["rev-parse", "HEAD"])).trim();
			const counts = async () => (await this.run([
				"rev-list",
				"--left-right",
				"--count",
				`HEAD...${upstream}`
			])).trim().split(/\s+/).map(Number);
			const [ahead, behind] = await counts();
			if (behind > 0 && ahead === 0) await this.run([
				"merge",
				"--ff-only",
				"--quiet",
				upstream
			]);
			else if (behind > 0) try {
				await this.run([
					"rebase",
					"--quiet",
					"--no-autostash",
					upstream
				]);
			} catch (error) {
				await this.run(["rebase", "--abort"]).catch(() => void 0);
				return result("conflict", `Local state commits conflict with ${upstream}; ${(await this.run(["rev-parse", "HEAD"]).catch(() => "")).trim() === before && !await this.busy() ? "the checkout is unchanged" : "the rebase could not be undone; inspect the checkout"}. Resolve it in the checkout. (${detail(error)})`);
			}
			const changed = behind > 0 && await this.differs(before, "HEAD");
			const pulled = behind > 0 ? `Pulled ${behind} commit${behind === 1 ? "" : "s"} from ${upstream}` : `Up to date with ${upstream}`;
			const [unpushed] = await counts();
			if (unpushed === 0) return result("synced", `${pulled}.`, changed);
			try {
				await this.run(["push", "--quiet"]);
			} catch (error) {
				return result("push-failed", `${pulled}; could not push ${unpushed} local commit${unpushed === 1 ? "" : "s"}: ${detail(error)}`, changed);
			}
			return result("synced", `${pulled}; pushed ${unpushed} local commit${unpushed === 1 ? "" : "s"}.`, changed);
		} catch (error) {
			return result("error", `State sync failed: ${detail(error)}`);
		}
	}
	/** True when a tracked file has uncommitted changes, or a rebase or merge is in progress. */
	async busy() {
		if ((await this.run([
			"--no-optional-locks",
			"status",
			"--porcelain",
			"--untracked-files=no"
		])).trim() !== "") return true;
		for (const name of [
			"rebase-merge",
			"rebase-apply",
			"MERGE_HEAD",
			"CHERRY_PICK_HEAD"
		]) {
			const path = (await this.run([
				"rev-parse",
				"--git-path",
				name
			])).trim();
			if (await stat(isAbsolute(path) ? path : join(this.checkout, path)).then(() => true, () => false)) return true;
		}
		return false;
	}
	async differs(from, to) {
		return (await this.run([
			"diff",
			"--name-only",
			from,
			to,
			"--",
			this.path
		])).trim() !== "";
	}
	/** Best effort: runs detached, never awaited, and its failure is ignored. */
	pushInBackground() {
		try {
			const invocation = gitInvocation(this.checkout, ["push", "--quiet"]);
			const child = spawn("git", invocation.args, {
				detached: true,
				stdio: "ignore",
				env: invocation.env
			});
			child.on("error", () => void 0);
			child.unref();
		} catch {}
	}
};
//#endregion
//#region src/state-schema.ts
/**
* The indra repository owns the state JSON Schema (`schema/v1/state.schema.json`); the copy in the state
* checkout follows it. At start-up Indra writes its own copy into the checkout when they differ, commits only
* that file (its subject records the build's full commit), and pushes it through the same sync as state.json.
* It never replaces a schema written by a build it does not include, so a rollback does not downgrade it.
*/
/** Where the schema lives, in the indra repository and in the state checkout alike. */
var STATE_SCHEMA_PATH = "schema/v1/state.schema.json";
var missing = (error) => error.code === "ENOENT";
/** The subject of Indra's schema commits, followed by the full commit of the build that wrote them. */
var COMMIT_SUBJECT = "Update state schema from Indra";
/** Whether `ancestor` is an ancestor of (or equal to) `commit` in the Indra checkout `appDir`; undefined when git cannot tell. */
function isAncestor(appDir, ancestor, commit) {
	return new Promise((resolve) => {
		execFile("git", [
			"-C",
			appDir,
			"merge-base",
			"--is-ancestor",
			ancestor,
			commit
		], {
			timeout: 1e4,
			env: {
				...childEnv(),
				GIT_TERMINAL_PROMPT: "0"
			}
		}, (error) => {
			if (!error) resolve(true);
			else resolve(error.code === 1 ? false : void 0);
		});
	});
}
/**
* Makes the state checkout's schema match this build's. Does nothing when they already match. Refuses, without
* writing anything, when the checkout has uncommitted changes to tracked files or the schema, or an unfinished
* rebase or merge: those are someone's hand edits, and Indra never commits them. Holds the state lock that every
* state write and sync holds. Never throws.
*/
async function syncStateSchema(checkout, options = {}) {
	const schema = options.schema ?? "{\n  \"$schema\": \"https://json-schema.org/draft/2020-12/schema\",\n  \"$id\": \"https://github.com/satoramoto/indra-state/blob/main/schema/v1/state.schema.json\",\n  \"title\": \"Indra state v1\",\n  \"type\": \"object\",\n  \"additionalProperties\": false,\n  \"required\": [\n    \"$schema\",\n    \"schemaVersion\",\n    \"teams\"\n  ],\n  \"properties\": {\n    \"$schema\": {\n      \"const\": \"./schema/v1/state.schema.json\"\n    },\n    \"schemaVersion\": {\n      \"const\": 1\n    },\n    \"teams\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"$ref\": \"#/$defs/team\"\n      }\n    },\n    \"sprints\": {\n      \"description\": \"Retired draft sprints from before planning goals. Ignored by Indra, which empties it at start-up; kept as [] because older builds require it.\",\n      \"deprecated\": true,\n      \"type\": \"array\"\n    },\n    \"planningGoals\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"$ref\": \"#/$defs/planningGoal\"\n      }\n    }\n  },\n  \"$defs\": {\n    \"id\": {\n      \"type\": \"string\",\n      \"pattern\": \"^[a-z][a-z0-9-]+$\"\n    },\n    \"nonEmptyText\": {\n      \"type\": \"string\",\n      \"minLength\": 1\n    },\n    \"mattermostTeam\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"teamId\"\n      ],\n      \"properties\": {\n        \"teamId\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"homeChannelId\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        }\n      }\n    },\n    \"project\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"github\"\n      ],\n      \"properties\": {\n        \"github\": {\n          \"type\": \"string\",\n          \"pattern\": \"^(?!\\\\.\\\\.?/)[A-Za-z0-9_.-]+/(?!\\\\.\\\\.?$)[A-Za-z0-9_.-]+$\"\n        }\n      }\n    },\n    \"mattermostSeat\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"userId\",\n        \"username\"\n      ],\n      \"properties\": {\n        \"userId\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"username\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        }\n      }\n    },\n    \"team\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"id\",\n        \"slug\",\n        \"displayName\",\n        \"externalIdentities\",\n        \"seats\"\n      ],\n      \"properties\": {\n        \"id\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"slug\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"displayName\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"project\": {\n          \"$ref\": \"#/$defs/project\"\n        },\n        \"externalIdentities\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"mattermost\"\n          ],\n          \"properties\": {\n            \"mattermost\": {\n              \"$ref\": \"#/$defs/mattermostTeam\"\n            }\n          }\n        },\n        \"seats\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"$ref\": \"#/$defs/seat\"\n          }\n        },\n        \"workflowModel\": {\n          \"const\": \"goals-v1\"\n        }\n      },\n      \"allOf\": [\n        {\n          \"if\": {\n            \"required\": [\n              \"workflowModel\"\n            ]\n          },\n          \"then\": {\n            \"properties\": {\n              \"seats\": {\n                \"allOf\": [\n                  {\n                    \"contains\": {\n                      \"type\": \"object\",\n                      \"properties\": {\n                        \"roles\": {\n                          \"const\": [\n                            \"Team Lead\"\n                          ]\n                        }\n                      },\n                      \"required\": [\n                        \"roles\"\n                      ]\n                    },\n                    \"minContains\": 1,\n                    \"maxContains\": 1\n                  },\n                  {\n                    \"contains\": {\n                      \"type\": \"object\",\n                      \"properties\": {\n                        \"roles\": {\n                          \"const\": [\n                            \"Product\"\n                          ]\n                        }\n                      },\n                      \"required\": [\n                        \"roles\"\n                      ]\n                    },\n                    \"minContains\": 1,\n                    \"maxContains\": 1\n                  },\n                  {\n                    \"contains\": {\n                      \"type\": \"object\",\n                      \"properties\": {\n                        \"roles\": {\n                          \"const\": [\n                            \"Developer\"\n                          ]\n                        }\n                      },\n                      \"required\": [\n                        \"roles\"\n                      ]\n                    },\n                    \"minContains\": 1\n                  }\n                ]\n              }\n            }\n          },\n          \"else\": {\n            \"properties\": {\n              \"seats\": {\n                \"not\": {\n                  \"contains\": {\n                    \"type\": \"object\",\n                    \"properties\": {\n                      \"roles\": {\n                        \"const\": [\n                          \"Product\"\n                        ]\n                      }\n                    },\n                    \"required\": [\n                      \"roles\"\n                    ]\n                  }\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"seat\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"id\",\n        \"displayName\",\n        \"roles\",\n        \"externalIdentities\"\n      ],\n      \"properties\": {\n        \"id\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"displayName\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"roles\": {\n          \"type\": \"array\",\n          \"minItems\": 1,\n          \"maxItems\": 1,\n          \"items\": {\n            \"enum\": [\n              \"Team Lead\",\n              \"Product\",\n              \"Developer\"\n            ]\n          }\n        },\n        \"externalIdentities\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"mattermost\"\n          ],\n          \"properties\": {\n            \"mattermost\": {\n              \"$ref\": \"#/$defs/mattermostSeat\"\n            }\n          }\n        }\n      }\n    },\n    \"planningGoal\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"id\",\n        \"teamId\",\n        \"seatId\",\n        \"participantSeatIds\",\n        \"goal\",\n        \"projectRefs\",\n        \"stage\",\n        \"createdAt\",\n        \"updatedAt\",\n        \"mattermost\",\n        \"brief\"\n      ],\n      \"allOf\": [\n        {\n          \"if\": {\n            \"required\": [\n              \"workflowModel\"\n            ]\n          },\n          \"then\": {\n            \"required\": [\n              \"ceremony\"\n            ],\n            \"not\": {\n              \"anyOf\": [\n                {\n                  \"required\": [\n                    \"proposal\"\n                  ]\n                },\n                {\n                  \"required\": [\n                    \"assignments\"\n                  ]\n                }\n              ]\n            },\n            \"allOf\": [\n              {\n                \"if\": {\n                  \"properties\": {\n                    \"stage\": {\n                      \"enum\": [\n                        \"awaiting-review\",\n                        \"approved\"\n                      ]\n                    }\n                  }\n                },\n                \"then\": {\n                  \"required\": [\n                    \"goalProposal\"\n                  ]\n                },\n                \"else\": {\n                  \"not\": {\n                    \"required\": [\n                      \"goalProposal\"\n                    ]\n                  }\n                }\n              },\n              {\n                \"if\": {\n                  \"properties\": {\n                    \"stage\": {\n                      \"const\": \"approved\"\n                    }\n                  }\n                },\n                \"then\": {\n                  \"required\": [\n                    \"ownedFiles\"\n                  ]\n                },\n                \"else\": {\n                  \"not\": {\n                    \"anyOf\": [\n                      {\n                        \"required\": [\n                          \"goalAssignment\"\n                        ]\n                      },\n                      {\n                        \"required\": [\n                          \"integration\"\n                        ]\n                      }\n                    ]\n                  }\n                }\n              },\n              {\n                \"if\": {\n                  \"required\": [\n                    \"goalAssignment\"\n                  ]\n                },\n                \"then\": {\n                  \"required\": [\n                    \"integration\"\n                  ]\n                }\n              }\n            ]\n          },\n          \"else\": {\n            \"not\": {\n              \"anyOf\": [\n                {\n                  \"required\": [\n                    \"goalProposal\"\n                  ]\n                },\n                {\n                  \"required\": [\n                    \"goalAssignment\"\n                  ]\n                },\n                {\n                  \"required\": [\n                    \"ownedFiles\"\n                  ]\n                }\n              ]\n            },\n            \"allOf\": [\n              {\n                \"if\": {\n                  \"properties\": {\n                    \"stage\": {\n                      \"enum\": [\n                        \"awaiting-review\",\n                        \"approved\"\n                      ]\n                    }\n                  },\n                  \"required\": [\n                    \"stage\"\n                  ]\n                },\n                \"then\": {\n                  \"required\": [\n                    \"proposal\"\n                  ]\n                },\n                \"else\": {\n                  \"not\": {\n                    \"required\": [\n                      \"proposal\"\n                    ]\n                  }\n                }\n              },\n              {\n                \"if\": {\n                  \"properties\": {\n                    \"stage\": {\n                      \"const\": \"approved\"\n                    }\n                  },\n                  \"required\": [\n                    \"stage\"\n                  ]\n                },\n                \"else\": {\n                  \"not\": {\n                    \"anyOf\": [\n                      {\n                        \"required\": [\n                          \"assignments\"\n                        ]\n                      },\n                      {\n                        \"required\": [\n                          \"integration\"\n                        ]\n                      }\n                    ]\n                  }\n                }\n              }\n            ]\n          }\n        }\n      ],\n      \"properties\": {\n        \"id\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"teamId\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"seatId\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"participantSeatIds\": {\n          \"type\": \"array\",\n          \"uniqueItems\": true,\n          \"items\": {\n            \"$ref\": \"#/$defs/id\"\n          }\n        },\n        \"goal\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"projectRefs\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"$ref\": \"#/$defs/nonEmptyText\"\n          }\n        },\n        \"stage\": {\n          \"enum\": [\n            \"clarifying\",\n            \"drafting\",\n            \"awaiting-review\",\n            \"approved\"\n          ]\n        },\n        \"createdAt\": {\n          \"type\": \"string\",\n          \"format\": \"date-time\"\n        },\n        \"updatedAt\": {\n          \"type\": \"string\",\n          \"format\": \"date-time\"\n        },\n        \"mattermost\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"channelId\",\n            \"rootPostId\"\n          ],\n          \"properties\": {\n            \"channelId\": {\n              \"$ref\": \"#/$defs/nonEmptyText\"\n            },\n            \"rootPostId\": {\n              \"$ref\": \"#/$defs/nonEmptyText\"\n            }\n          }\n        },\n        \"brief\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"summary\",\n            \"decisions\",\n            \"openQuestions\"\n          ],\n          \"properties\": {\n            \"summary\": {\n              \"$ref\": \"#/$defs/nonEmptyText\"\n            },\n            \"decisions\": {\n              \"type\": \"array\",\n              \"items\": {\n                \"$ref\": \"#/$defs/nonEmptyText\"\n              }\n            },\n            \"openQuestions\": {\n              \"type\": \"array\",\n              \"items\": {\n                \"$ref\": \"#/$defs/nonEmptyText\"\n              }\n            }\n          }\n        },\n        \"proposal\": {\n          \"$ref\": \"#/$defs/planningProposal\"\n        },\n        \"assignments\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"$ref\": \"#/$defs/planningAssignment\"\n          }\n        },\n        \"integration\": {\n          \"$ref\": \"#/$defs/sprintIntegration\"\n        },\n        \"ceremony\": {\n          \"$ref\": \"#/$defs/ceremony\"\n        },\n        \"workflowModel\": {\n          \"const\": \"goals-v1\"\n        },\n        \"ownedFiles\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"type\": \"string\",\n            \"pattern\": \"\\\\S\"\n          },\n          \"minItems\": 1,\n          \"maxItems\": 128\n        },\n        \"goalProposal\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"version\",\n            \"goalId\",\n            \"proposalId\",\n            \"productSeatId\",\n            \"rank\",\n            \"mission\",\n            \"summary\",\n            \"outcomes\",\n            \"ownedFiles\",\n            \"risks\",\n            \"rationale\",\n            \"basedOnRetros\"\n          ],\n          \"properties\": {\n            \"version\": {\n              \"type\": \"integer\",\n              \"const\": 1\n            },\n            \"goalId\": {\n              \"type\": \"string\",\n              \"pattern\": \"^[a-z][a-z0-9-]*$\"\n            },\n            \"proposalId\": {\n              \"type\": \"string\",\n              \"pattern\": \"^[a-z][a-z0-9-]*$\"\n            },\n            \"productSeatId\": {\n              \"type\": \"string\",\n              \"pattern\": \"^[a-z][a-z0-9-]*$\"\n            },\n            \"rank\": {\n              \"type\": \"integer\",\n              \"minimum\": 1\n            },\n            \"mission\": {\n              \"type\": \"string\",\n              \"pattern\": \"\\\\S\"\n            },\n            \"summary\": {\n              \"type\": \"string\",\n              \"pattern\": \"\\\\S\"\n            },\n            \"outcomes\": {\n              \"type\": \"array\",\n              \"items\": {\n                \"type\": \"object\",\n                \"additionalProperties\": false,\n                \"required\": [\n                  \"number\",\n                  \"title\",\n                  \"description\",\n                  \"reason\",\n                  \"currentCode\"\n                ],\n                \"properties\": {\n                  \"number\": {\n                    \"type\": \"integer\",\n                    \"minimum\": 1\n                  },\n                  \"title\": {\n                    \"type\": \"string\",\n                    \"pattern\": \"\\\\S\"\n                  },\n                  \"description\": {\n                    \"type\": \"string\",\n                    \"pattern\": \"\\\\S\"\n                  },\n                  \"reason\": {\n                    \"type\": \"string\",\n                    \"pattern\": \"\\\\S\"\n                  },\n                  \"currentCode\": {\n                    \"type\": \"array\",\n                    \"items\": {\n                      \"type\": \"string\",\n                      \"pattern\": \"\\\\S\"\n                    }\n                  }\n                }\n              },\n              \"minItems\": 1\n            },\n            \"ownedFiles\": {\n              \"type\": \"array\",\n              \"items\": {\n                \"type\": \"string\",\n                \"pattern\": \"\\\\S\"\n              },\n              \"minItems\": 1,\n              \"maxItems\": 128\n            },\n            \"risks\": {\n              \"type\": \"array\",\n              \"items\": {\n                \"type\": \"string\",\n                \"pattern\": \"\\\\S\"\n              }\n            },\n            \"rationale\": {\n              \"type\": \"string\",\n              \"pattern\": \"\\\\S\"\n            },\n            \"basedOnRetros\": {\n              \"type\": \"array\",\n              \"items\": {\n                \"type\": \"string\",\n                \"pattern\": \"\\\\S\"\n              }\n            }\n          }\n        },\n        \"goalAssignment\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"seatId\",\n            \"status\",\n            \"updatedAt\"\n          ],\n          \"properties\": {\n            \"seatId\": {\n              \"type\": \"string\",\n              \"pattern\": \"^[a-z][a-z0-9-]*$\"\n            },\n            \"status\": {\n              \"enum\": [\n                \"assigned\",\n                \"running\",\n                \"reported\",\n                \"failed\"\n              ]\n            },\n            \"updatedAt\": {\n              \"type\": \"string\",\n              \"format\": \"date-time\"\n            }\n          }\n        }\n      }\n    },\n    \"sprintIntegration\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"branch\",\n        \"baseSha\",\n        \"status\"\n      ],\n      \"allOf\": [\n        {\n          \"if\": {\n            \"properties\": {\n              \"status\": {\n                \"enum\": [\n                  \"pr-open\",\n                  \"merged\",\n                  \"reverted\"\n                ]\n              }\n            }\n          },\n          \"then\": {\n            \"required\": [\n              \"prUrl\"\n            ]\n          }\n        },\n        {\n          \"if\": {\n            \"properties\": {\n              \"status\": {\n                \"enum\": [\n                  \"merged\",\n                  \"reverted\"\n                ]\n              }\n            }\n          },\n          \"then\": {\n            \"required\": [\n              \"mergedSha\"\n            ]\n          }\n        },\n        {\n          \"if\": {\n            \"properties\": {\n              \"status\": {\n                \"const\": \"reverted\"\n              }\n            }\n          },\n          \"then\": {\n            \"required\": [\n              \"revertPrUrl\"\n            ]\n          }\n        }\n      ],\n      \"properties\": {\n        \"branch\": {\n          \"type\": \"string\",\n          \"pattern\": \"^sprint/[a-z][a-z0-9-]+$\"\n        },\n        \"baseSha\": {\n          \"$ref\": \"#/$defs/gitSha\"\n        },\n        \"status\": {\n          \"enum\": [\n            \"collecting\",\n            \"pr-open\",\n            \"merged\",\n            \"reverted\"\n          ]\n        },\n        \"prUrl\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"mergedSha\": {\n          \"$ref\": \"#/$defs/gitSha\"\n        },\n        \"revertPrUrl\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        }\n      }\n    },\n    \"gitSha\": {\n      \"type\": \"string\",\n      \"pattern\": \"^[0-9a-f]{40}$\"\n    },\n    \"planningAssignment\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"outcomeId\",\n        \"seatId\",\n        \"status\",\n        \"updatedAt\"\n      ],\n      \"properties\": {\n        \"outcomeId\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"seatId\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"status\": {\n          \"enum\": [\n            \"queued\",\n            \"running\",\n            \"in-review\",\n            \"merged\",\n            \"failed\"\n          ]\n        },\n        \"updatedAt\": {\n          \"type\": \"string\",\n          \"format\": \"date-time\"\n        },\n        \"prUrl\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"note\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        }\n      }\n    },\n    \"planningProposal\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"id\",\n        \"createdAt\",\n        \"summary\",\n        \"outcomes\",\n        \"risks\",\n        \"openQuestions\"\n      ],\n      \"properties\": {\n        \"id\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"createdAt\": {\n          \"type\": \"string\",\n          \"format\": \"date-time\"\n        },\n        \"summary\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"outcomes\": {\n          \"type\": \"array\",\n          \"minItems\": 1,\n          \"items\": {\n            \"$ref\": \"#/$defs/planningOutcome\"\n          }\n        },\n        \"risks\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"$ref\": \"#/$defs/nonEmptyText\"\n          }\n        },\n        \"openQuestions\": {\n          \"type\": \"array\",\n          \"items\": {\n            \"$ref\": \"#/$defs/nonEmptyText\"\n          }\n        }\n      }\n    },\n    \"planningOutcome\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"id\",\n        \"title\",\n        \"description\",\n        \"seatId\"\n      ],\n      \"properties\": {\n        \"id\": {\n          \"$ref\": \"#/$defs/id\"\n        },\n        \"title\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"description\": {\n          \"$ref\": \"#/$defs/nonEmptyText\"\n        },\n        \"seatId\": {\n          \"$ref\": \"#/$defs/id\"\n        }\n      }\n    },\n    \"ceremonyText\": {\n      \"type\": \"string\",\n      \"pattern\": \"\\\\S\"\n    },\n    \"ceremonyTime\": {\n      \"type\": \"string\",\n      \"format\": \"date-time\"\n    },\n    \"ceremonySha\": {\n      \"type\": \"string\",\n      \"pattern\": \"^[0-9a-f]{40}$\"\n    },\n    \"ceremonyId\": {\n      \"type\": \"string\",\n      \"pattern\": \"^[a-z][a-z0-9-]+$\"\n    },\n    \"ceremonyPr\": {\n      \"type\": \"string\",\n      \"pattern\": \"^https://github\\\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$\"\n    },\n    \"ceremonyHumanApproval\": {\n      \"oneOf\": [\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"source\",\n            \"command\",\n            \"at\"\n          ],\n          \"properties\": {\n            \"source\": {\n              \"const\": \"owner-command\"\n            },\n            \"command\": {\n              \"enum\": [\n                \"planning approve\",\n                \"planning merge\"\n              ]\n            },\n            \"at\": {\n              \"$ref\": \"#/$defs/ceremonyTime\"\n            }\n          }\n        },\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"source\",\n            \"userId\",\n            \"postId\",\n            \"emoji\",\n            \"verifiedHuman\",\n            \"at\"\n          ],\n          \"properties\": {\n            \"source\": {\n              \"const\": \"reaction\"\n            },\n            \"userId\": {\n              \"$ref\": \"#/$defs/ceremonyText\"\n            },\n            \"postId\": {\n              \"$ref\": \"#/$defs/ceremonyText\"\n            },\n            \"emoji\": {\n              \"const\": \"white_check_mark\"\n            },\n            \"verifiedHuman\": {\n              \"const\": true\n            },\n            \"at\": {\n              \"$ref\": \"#/$defs/ceremonyTime\"\n            }\n          }\n        }\n      ]\n    },\n    \"ceremonyApproval\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"kind\",\n        \"proposalId\",\n        \"proposalPostId\",\n        \"approval\"\n      ],\n      \"properties\": {\n        \"kind\": {\n          \"const\": \"approval\"\n        },\n        \"proposalId\": {\n          \"$ref\": \"#/$defs/ceremonyId\"\n        },\n        \"proposalPostId\": {\n          \"$ref\": \"#/$defs/ceremonyText\"\n        },\n        \"approval\": {\n          \"$ref\": \"#/$defs/ceremonyHumanApproval\"\n        }\n      }\n    },\n    \"ceremonyImplementation\": {\n      \"anyOf\": [\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"kind\",\n            \"outcomes\"\n          ],\n          \"properties\": {\n            \"kind\": {\n              \"const\": \"implementation\"\n            },\n            \"outcomes\": {\n              \"type\": \"array\",\n              \"minItems\": 1,\n              \"items\": {\n                \"type\": \"object\",\n                \"additionalProperties\": false,\n                \"required\": [\n                  \"outcomeId\",\n                  \"seatId\",\n                  \"prUrl\",\n                  \"baseBranch\",\n                  \"mergedSha\",\n                  \"checksPassed\",\n                  \"reviewApproved\"\n                ],\n                \"properties\": {\n                  \"outcomeId\": {\n                    \"$ref\": \"#/$defs/ceremonyId\"\n                  },\n                  \"seatId\": {\n                    \"$ref\": \"#/$defs/ceremonyId\"\n                  },\n                  \"prUrl\": {\n                    \"$ref\": \"#/$defs/ceremonyPr\"\n                  },\n                  \"baseBranch\": {\n                    \"$ref\": \"#/$defs/ceremonyText\"\n                  },\n                  \"mergedSha\": {\n                    \"$ref\": \"#/$defs/ceremonySha\"\n                  },\n                  \"checksPassed\": {\n                    \"const\": true\n                  },\n                  \"reviewApproved\": {\n                    \"const\": true\n                  }\n                }\n              }\n            },\n            \"omissions\": {\n              \"type\": \"array\",\n              \"minItems\": 1,\n              \"items\": {\n                \"type\": \"object\",\n                \"additionalProperties\": false,\n                \"required\": [\n                  \"outcomeId\",\n                  \"seatId\",\n                  \"reason\"\n                ],\n                \"properties\": {\n                  \"outcomeId\": {\n                    \"$ref\": \"#/$defs/ceremonyId\"\n                  },\n                  \"seatId\": {\n                    \"$ref\": \"#/$defs/ceremonyId\"\n                  },\n                  \"reason\": {\n                    \"$ref\": \"#/$defs/ceremonyText\"\n                  }\n                }\n              }\n            },\n            \"partialApproval\": {\n              \"type\": \"object\",\n              \"additionalProperties\": false,\n              \"required\": [\n                \"source\",\n                \"command\",\n                \"at\"\n              ],\n              \"properties\": {\n                \"source\": {\n                  \"const\": \"owner-command\"\n                },\n                \"command\": {\n                  \"const\": \"planning integrate\"\n                },\n                \"at\": {\n                  \"$ref\": \"#/$defs/ceremonyTime\"\n                }\n              }\n            }\n          },\n          \"allOf\": [\n            {\n              \"if\": {\n                \"required\": [\n                  \"omissions\"\n                ]\n              },\n              \"then\": {\n                \"required\": [\n                  \"partialApproval\"\n                ]\n              }\n            },\n            {\n              \"if\": {\n                \"required\": [\n                  \"partialApproval\"\n                ]\n              },\n              \"then\": {\n                \"required\": [\n                  \"omissions\"\n                ]\n              }\n            }\n          ]\n        },\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"kind\",\n            \"outcomes\",\n            \"goalDelivery\"\n          ],\n          \"properties\": {\n            \"kind\": {\n              \"const\": \"implementation\"\n            },\n            \"outcomes\": {\n              \"type\": \"array\",\n              \"maxItems\": 0\n            },\n            \"goalDelivery\": {\n              \"type\": \"object\",\n              \"additionalProperties\": false,\n              \"required\": [\n                \"version\",\n                \"goalId\",\n                \"teamId\",\n                \"seatId\",\n                \"sprintBranch\",\n                \"headSha\",\n                \"lanePrs\",\n                \"checks\",\n                \"decisions\",\n                \"followUps\",\n                \"neededButUnowned\"\n              ],\n              \"properties\": {\n                \"version\": {\n                  \"const\": 1\n                },\n                \"goalId\": {\n                  \"$ref\": \"#/$defs/ceremonyId\"\n                },\n                \"teamId\": {\n                  \"$ref\": \"#/$defs/ceremonyId\"\n                },\n                \"seatId\": {\n                  \"$ref\": \"#/$defs/ceremonyId\"\n                },\n                \"sprintBranch\": {\n                  \"$ref\": \"#/$defs/ceremonyText\"\n                },\n                \"headSha\": {\n                  \"$ref\": \"#/$defs/ceremonySha\"\n                },\n                \"lanePrs\": {\n                  \"type\": \"array\",\n                  \"minItems\": 1,\n                  \"items\": {\n                    \"type\": \"object\",\n                    \"additionalProperties\": false,\n                    \"required\": [\n                      \"laneId\",\n                      \"url\",\n                      \"headSha\",\n                      \"mergedSha\",\n                      \"reviewer\",\n                      \"ci\"\n                    ],\n                    \"properties\": {\n                      \"laneId\": {\n                        \"$ref\": \"#/$defs/ceremonyId\"\n                      },\n                      \"url\": {\n                        \"$ref\": \"#/$defs/ceremonyPr\"\n                      },\n                      \"headSha\": {\n                        \"$ref\": \"#/$defs/ceremonySha\"\n                      },\n                      \"mergedSha\": {\n                        \"$ref\": \"#/$defs/ceremonySha\"\n                      },\n                      \"reviewer\": {\n                        \"const\": \"satori-miyamoto\"\n                      },\n                      \"ci\": {\n                        \"const\": \"passed\"\n                      }\n                    }\n                  }\n                },\n                \"checks\": {\n                  \"type\": \"array\",\n                  \"minItems\": 1,\n                  \"items\": {\n                    \"type\": \"object\",\n                    \"additionalProperties\": false,\n                    \"required\": [\n                      \"command\",\n                      \"exitCode\"\n                    ],\n                    \"properties\": {\n                      \"command\": {\n                        \"$ref\": \"#/$defs/ceremonyText\"\n                      },\n                      \"exitCode\": {\n                        \"type\": \"integer\"\n                      }\n                    }\n                  }\n                },\n                \"decisions\": {\n                  \"type\": \"array\",\n                  \"items\": {\n                    \"$ref\": \"#/$defs/ceremonyText\"\n                  }\n                },\n                \"followUps\": {\n                  \"type\": \"array\",\n                  \"items\": {\n                    \"$ref\": \"#/$defs/ceremonyText\"\n                  }\n                },\n                \"neededButUnowned\": {\n                  \"type\": \"array\",\n                  \"items\": {\n                    \"$ref\": \"#/$defs/ceremonyText\"\n                  }\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"ceremonyRelease\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"kind\",\n        \"prUrl\",\n        \"mergedSha\",\n        \"checksPassed\",\n        \"buildSha\",\n        \"runningSha\",\n        \"runningAt\"\n      ],\n      \"properties\": {\n        \"kind\": {\n          \"const\": \"release-running\"\n        },\n        \"prUrl\": {\n          \"$ref\": \"#/$defs/ceremonyPr\"\n        },\n        \"mergedSha\": {\n          \"$ref\": \"#/$defs/ceremonySha\"\n        },\n        \"mergePostId\": {\n          \"$ref\": \"#/$defs/ceremonyText\"\n        },\n        \"approval\": {\n          \"$ref\": \"#/$defs/ceremonyHumanApproval\"\n        },\n        \"mergeVerification\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"headSha\",\n            \"reviewCommitSha\",\n            \"reviewer\",\n            \"checksPassed\"\n          ],\n          \"properties\": {\n            \"headSha\": {\n              \"$ref\": \"#/$defs/ceremonySha\"\n            },\n            \"reviewCommitSha\": {\n              \"$ref\": \"#/$defs/ceremonySha\"\n            },\n            \"reviewer\": {\n              \"const\": \"satori-miyamoto\"\n            },\n            \"checksPassed\": {\n              \"const\": true\n            }\n          }\n        },\n        \"checksPassed\": {\n          \"const\": true\n        },\n        \"buildSha\": {\n          \"$ref\": \"#/$defs/ceremonySha\"\n        },\n        \"runningSha\": {\n          \"$ref\": \"#/$defs/ceremonySha\"\n        },\n        \"runningAt\": {\n          \"$ref\": \"#/$defs/ceremonyTime\"\n        },\n        \"ancestry\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"ancestorSha\",\n            \"descendantSha\",\n            \"verified\"\n          ],\n          \"properties\": {\n            \"ancestorSha\": {\n              \"$ref\": \"#/$defs/ceremonySha\"\n            },\n            \"descendantSha\": {\n              \"$ref\": \"#/$defs/ceremonySha\"\n            },\n            \"verified\": {\n              \"const\": true\n            }\n          }\n        }\n      },\n      \"anyOf\": [\n        {\n          \"required\": [\n            \"mergeVerification\"\n          ]\n        },\n        {\n          \"required\": [\n            \"mergePostId\",\n            \"approval\"\n          ]\n        }\n      ]\n    },\n    \"ceremonyRetro\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"kind\",\n        \"path\",\n        \"prUrl\",\n        \"baseBranch\",\n        \"mergedSha\",\n        \"postId\",\n        \"publishedAt\",\n        \"factsOnly\",\n        \"suggestions\"\n      ],\n      \"properties\": {\n        \"kind\": {\n          \"const\": \"retro-published\"\n        },\n        \"path\": {\n          \"type\": \"string\",\n          \"pattern\": \"^docs/retros/[a-z][a-z0-9-]+\\\\.md$\"\n        },\n        \"prUrl\": {\n          \"$ref\": \"#/$defs/ceremonyPr\"\n        },\n        \"baseBranch\": {\n          \"const\": \"main\"\n        },\n        \"mergedSha\": {\n          \"$ref\": \"#/$defs/ceremonySha\"\n        },\n        \"postId\": {\n          \"$ref\": \"#/$defs/ceremonyText\"\n        },\n        \"publishedAt\": {\n          \"$ref\": \"#/$defs/ceremonyTime\"\n        },\n        \"factsOnly\": {\n          \"const\": true\n        },\n        \"suggestions\": {\n          \"const\": \"owner-proposals-only\"\n        }\n      }\n    },\n    \"ceremonyLegacyApproval\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"kind\",\n        \"proposalId\"\n      ],\n      \"properties\": {\n        \"kind\": {\n          \"const\": \"legacy-approval\"\n        },\n        \"proposalId\": {\n          \"$ref\": \"#/$defs/ceremonyId\"\n        }\n      }\n    },\n    \"ceremonyLegacyImplementation\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"kind\",\n        \"outcomes\"\n      ],\n      \"properties\": {\n        \"kind\": {\n          \"const\": \"legacy-implementation\"\n        },\n        \"outcomes\": {\n          \"type\": \"array\",\n          \"minItems\": 1,\n          \"items\": {\n            \"type\": \"object\",\n            \"additionalProperties\": false,\n            \"required\": [\n              \"outcomeId\",\n              \"seatId\",\n              \"prUrl\"\n            ],\n            \"properties\": {\n              \"outcomeId\": {\n                \"$ref\": \"#/$defs/ceremonyId\"\n              },\n              \"seatId\": {\n                \"$ref\": \"#/$defs/ceremonyId\"\n              },\n              \"prUrl\": {\n                \"$ref\": \"#/$defs/ceremonyPr\"\n              }\n            }\n          }\n        },\n        \"unmerged\": {\n          \"type\": \"array\",\n          \"minItems\": 1,\n          \"items\": {\n            \"type\": \"object\",\n            \"additionalProperties\": false,\n            \"required\": [\n              \"outcomeId\",\n              \"seatId\"\n            ],\n            \"properties\": {\n              \"outcomeId\": {\n                \"$ref\": \"#/$defs/ceremonyId\"\n              },\n              \"seatId\": {\n                \"$ref\": \"#/$defs/ceremonyId\"\n              }\n            }\n          }\n        }\n      }\n    },\n    \"ceremonyRevertedRelease\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"kind\",\n        \"prUrl\",\n        \"mergedSha\",\n        \"revertPrUrl\"\n      ],\n      \"properties\": {\n        \"kind\": {\n          \"const\": \"release-reverted\"\n        },\n        \"prUrl\": {\n          \"$ref\": \"#/$defs/ceremonyPr\"\n        },\n        \"mergedSha\": {\n          \"$ref\": \"#/$defs/ceremonySha\"\n        },\n        \"revertPrUrl\": {\n          \"$ref\": \"#/$defs/ceremonyPr\"\n        }\n      }\n    },\n    \"ceremonyLegacyClosure\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"kind\",\n        \"integration\"\n      ],\n      \"properties\": {\n        \"kind\": {\n          \"const\": \"legacy-migration\"\n        },\n        \"integration\": {\n          \"enum\": [\n            \"none\",\n            \"merged\",\n            \"reverted\"\n          ]\n        },\n        \"prUrl\": {\n          \"$ref\": \"#/$defs/ceremonyPr\"\n        },\n        \"mergedSha\": {\n          \"$ref\": \"#/$defs/ceremonySha\"\n        },\n        \"revertPrUrl\": {\n          \"$ref\": \"#/$defs/ceremonyPr\"\n        }\n      }\n    },\n    \"ceremonyEntry\": {\n      \"oneOf\": [\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"stage\",\n            \"enteredAt\"\n          ],\n          \"properties\": {\n            \"stage\": {\n              \"enum\": [\n                \"planning\",\n                \"proposal\"\n              ]\n            },\n            \"enteredAt\": {\n              \"anyOf\": [\n                {\n                  \"$ref\": \"#/$defs/ceremonyTime\"\n                },\n                {\n                  \"type\": \"null\"\n                }\n              ]\n            }\n          }\n        },\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"stage\",\n            \"enteredAt\",\n            \"evidence\"\n          ],\n          \"properties\": {\n            \"stage\": {\n              \"const\": \"implement\"\n            },\n            \"enteredAt\": {\n              \"anyOf\": [\n                {\n                  \"$ref\": \"#/$defs/ceremonyTime\"\n                },\n                {\n                  \"type\": \"null\"\n                }\n              ]\n            },\n            \"evidence\": {\n              \"$ref\": \"#/$defs/ceremonyApproval\"\n            }\n          }\n        },\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"stage\",\n            \"enteredAt\",\n            \"evidence\"\n          ],\n          \"properties\": {\n            \"stage\": {\n              \"const\": \"implement\"\n            },\n            \"enteredAt\": {\n              \"type\": \"null\"\n            },\n            \"evidence\": {\n              \"$ref\": \"#/$defs/ceremonyLegacyApproval\"\n            }\n          }\n        },\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"stage\",\n            \"enteredAt\",\n            \"evidence\"\n          ],\n          \"properties\": {\n            \"stage\": {\n              \"const\": \"release\"\n            },\n            \"enteredAt\": {\n              \"anyOf\": [\n                {\n                  \"$ref\": \"#/$defs/ceremonyTime\"\n                },\n                {\n                  \"type\": \"null\"\n                }\n              ]\n            },\n            \"evidence\": {\n              \"$ref\": \"#/$defs/ceremonyImplementation\"\n            }\n          }\n        },\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"stage\",\n            \"enteredAt\",\n            \"evidence\"\n          ],\n          \"properties\": {\n            \"stage\": {\n              \"const\": \"release\"\n            },\n            \"enteredAt\": {\n              \"type\": \"null\"\n            },\n            \"evidence\": {\n              \"$ref\": \"#/$defs/ceremonyLegacyImplementation\"\n            }\n          }\n        },\n        {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"stage\",\n            \"enteredAt\",\n            \"evidence\"\n          ],\n          \"properties\": {\n            \"stage\": {\n              \"const\": \"retro\"\n            },\n            \"enteredAt\": {\n              \"anyOf\": [\n                {\n                  \"$ref\": \"#/$defs/ceremonyTime\"\n                },\n                {\n                  \"type\": \"null\"\n                }\n              ]\n            },\n            \"evidence\": {\n              \"$ref\": \"#/$defs/ceremonyRelease\"\n            }\n          }\n        }\n      ]\n    },\n    \"ceremony\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"version\",\n        \"stage\",\n        \"history\"\n      ],\n      \"properties\": {\n        \"version\": {\n          \"const\": 1\n        },\n        \"stage\": {\n          \"enum\": [\n            \"planning\",\n            \"proposal\",\n            \"implement\",\n            \"release\",\n            \"retro\"\n          ]\n        },\n        \"history\": {\n          \"type\": \"array\",\n          \"minItems\": 1,\n          \"maxItems\": 5,\n          \"items\": {\n            \"$ref\": \"#/$defs/ceremonyEntry\"\n          }\n        },\n        \"migratedAt\": {\n          \"$ref\": \"#/$defs/ceremonyTime\"\n        },\n        \"closure\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"closedAt\",\n            \"evidence\"\n          ],\n          \"properties\": {\n            \"closedAt\": {\n              \"$ref\": \"#/$defs/ceremonyTime\"\n            },\n            \"evidence\": {\n              \"oneOf\": [\n                {\n                  \"$ref\": \"#/$defs/ceremonyRetro\"\n                },\n                {\n                  \"$ref\": \"#/$defs/ceremonyRevertedRelease\"\n                },\n                {\n                  \"$ref\": \"#/$defs/ceremonyLegacyClosure\"\n                },\n                {\n                  \"$ref\": \"#/$defs/ceremonyRemodelClosure\"\n                }\n              ]\n            }\n          }\n        }\n      },\n      \"allOf\": [\n        {\n          \"if\": {\n            \"properties\": {\n              \"stage\": {\n                \"const\": \"planning\"\n              }\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"history\": {\n                \"minItems\": 1,\n                \"maxItems\": 1,\n                \"prefixItems\": [\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"planning\"\n                      }\n                    }\n                  }\n                ]\n              }\n            }\n          }\n        },\n        {\n          \"if\": {\n            \"properties\": {\n              \"stage\": {\n                \"const\": \"proposal\"\n              }\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"history\": {\n                \"minItems\": 2,\n                \"maxItems\": 2,\n                \"prefixItems\": [\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"planning\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"proposal\"\n                      }\n                    }\n                  }\n                ]\n              }\n            }\n          }\n        },\n        {\n          \"if\": {\n            \"properties\": {\n              \"stage\": {\n                \"const\": \"implement\"\n              }\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"history\": {\n                \"minItems\": 3,\n                \"maxItems\": 3,\n                \"prefixItems\": [\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"planning\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"proposal\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"implement\"\n                      }\n                    }\n                  }\n                ]\n              }\n            }\n          }\n        },\n        {\n          \"if\": {\n            \"properties\": {\n              \"stage\": {\n                \"const\": \"release\"\n              }\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"history\": {\n                \"minItems\": 4,\n                \"maxItems\": 4,\n                \"prefixItems\": [\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"planning\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"proposal\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"implement\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"release\"\n                      }\n                    }\n                  }\n                ]\n              }\n            }\n          }\n        },\n        {\n          \"if\": {\n            \"properties\": {\n              \"stage\": {\n                \"const\": \"retro\"\n              }\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"history\": {\n                \"minItems\": 5,\n                \"maxItems\": 5,\n                \"prefixItems\": [\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"planning\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"proposal\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"implement\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"release\"\n                      }\n                    }\n                  },\n                  {\n                    \"properties\": {\n                      \"stage\": {\n                        \"const\": \"retro\"\n                      }\n                    }\n                  }\n                ]\n              }\n            }\n          }\n        },\n        {\n          \"if\": {\n            \"required\": [\n              \"closure\"\n            ],\n            \"properties\": {\n              \"closure\": {\n                \"properties\": {\n                  \"evidence\": {\n                    \"properties\": {\n                      \"kind\": {\n                        \"enum\": [\n                          \"retro-published\"\n                        ]\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"stage\": {\n                \"const\": \"retro\"\n              }\n            }\n          }\n        },\n        {\n          \"if\": {\n            \"required\": [\n              \"closure\"\n            ],\n            \"properties\": {\n              \"closure\": {\n                \"properties\": {\n                  \"evidence\": {\n                    \"properties\": {\n                      \"kind\": {\n                        \"enum\": [\n                          \"release-reverted\",\n                          \"legacy-migration\"\n                        ]\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"stage\": {\n                \"const\": \"release\"\n              }\n            }\n          }\n        },\n        {\n          \"if\": {\n            \"required\": [\n              \"closure\"\n            ],\n            \"properties\": {\n              \"closure\": {\n                \"properties\": {\n                  \"evidence\": {\n                    \"properties\": {\n                      \"kind\": {\n                        \"enum\": [\n                          \"remodel-closure\"\n                        ]\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"stage\": {\n                \"enum\": [\n                  \"implement\",\n                  \"release\",\n                  \"retro\"\n                ]\n              }\n            }\n          }\n        },\n        {\n          \"if\": {\n            \"required\": [\n              \"closure\"\n            ],\n            \"properties\": {\n              \"closure\": {\n                \"properties\": {\n                  \"evidence\": {\n                    \"properties\": {\n                      \"kind\": {\n                        \"enum\": [\n                          \"legacy-migration\"\n                        ]\n                      }\n                    }\n                  }\n                }\n              }\n            }\n          },\n          \"then\": {\n            \"required\": [\n              \"migratedAt\"\n            ]\n          }\n        },\n        {\n          \"if\": {\n            \"not\": {\n              \"required\": [\n                \"migratedAt\"\n              ]\n            }\n          },\n          \"then\": {\n            \"properties\": {\n              \"history\": {\n                \"items\": {\n                  \"properties\": {\n                    \"enteredAt\": {\n                      \"$ref\": \"#/$defs/ceremonyTime\"\n                    }\n                  }\n                }\n              }\n            }\n          }\n        }\n      ]\n    },\n    \"ceremonyRemodelClosure\": {\n      \"type\": \"object\",\n      \"additionalProperties\": false,\n      \"required\": [\n        \"kind\",\n        \"goalId\",\n        \"stage\",\n        \"reason\",\n        \"observed\"\n      ],\n      \"properties\": {\n        \"kind\": {\n          \"const\": \"remodel-closure\"\n        },\n        \"goalId\": {\n          \"enum\": [\n            \"goal-2b118e79\",\n            \"goal-855701cc\",\n            \"goal-ca9dd9ed\",\n            \"goal-df104a26\",\n            \"goal-88dd199e\",\n            \"goal-96296dff\"\n          ]\n        },\n        \"stage\": {\n          \"enum\": [\n            \"implement\",\n            \"release\",\n            \"retro\"\n          ]\n        },\n        \"reason\": {\n          \"enum\": [\n            \"abandoned\",\n            \"superseded\"\n          ]\n        },\n        \"observed\": {\n          \"type\": \"object\",\n          \"additionalProperties\": false,\n          \"required\": [\n            \"planningStage\",\n            \"integration\",\n            \"assignments\"\n          ],\n          \"properties\": {\n            \"planningStage\": {\n              \"enum\": [\n                \"clarifying\",\n                \"drafting\",\n                \"awaiting-review\",\n                \"approved\"\n              ]\n            },\n            \"integration\": {\n              \"anyOf\": [\n                {\n                  \"type\": \"null\"\n                },\n                {\n                  \"type\": \"object\",\n                  \"additionalProperties\": false,\n                  \"required\": [\n                    \"branch\",\n                    \"baseSha\",\n                    \"status\",\n                    \"prUrl\",\n                    \"mergedSha\",\n                    \"revertPrUrl\"\n                  ],\n                  \"properties\": {\n                    \"branch\": {\n                      \"$ref\": \"#/$defs/ceremonyText\"\n                    },\n                    \"baseSha\": {\n                      \"$ref\": \"#/$defs/ceremonySha\"\n                    },\n                    \"status\": {\n                      \"enum\": [\n                        \"collecting\",\n                        \"pr-open\",\n                        \"merged\",\n                        \"reverted\"\n                      ]\n                    },\n                    \"prUrl\": {\n                      \"anyOf\": [\n                        {\n                          \"$ref\": \"#/$defs/ceremonyPr\"\n                        },\n                        {\n                          \"type\": \"null\"\n                        }\n                      ]\n                    },\n                    \"mergedSha\": {\n                      \"anyOf\": [\n                        {\n                          \"$ref\": \"#/$defs/ceremonySha\"\n                        },\n                        {\n                          \"type\": \"null\"\n                        }\n                      ]\n                    },\n                    \"revertPrUrl\": {\n                      \"anyOf\": [\n                        {\n                          \"$ref\": \"#/$defs/ceremonyPr\"\n                        },\n                        {\n                          \"type\": \"null\"\n                        }\n                      ]\n                    }\n                  }\n                }\n              ]\n            },\n            \"assignments\": {\n              \"type\": \"array\",\n              \"items\": {\n                \"type\": \"object\",\n                \"additionalProperties\": false,\n                \"required\": [\n                  \"outcomeId\",\n                  \"seatId\",\n                  \"status\",\n                  \"updatedAt\",\n                  \"prUrl\",\n                  \"note\"\n                ],\n                \"properties\": {\n                  \"outcomeId\": {\n                    \"$ref\": \"#/$defs/ceremonyId\"\n                  },\n                  \"seatId\": {\n                    \"$ref\": \"#/$defs/ceremonyId\"\n                  },\n                  \"status\": {\n                    \"enum\": [\n                      \"queued\",\n                      \"running\",\n                      \"in-review\",\n                      \"merged\",\n                      \"failed\"\n                    ]\n                  },\n                  \"updatedAt\": {\n                    \"$ref\": \"#/$defs/ceremonyTime\"\n                  },\n                  \"prUrl\": {\n                    \"anyOf\": [\n                      {\n                        \"$ref\": \"#/$defs/ceremonyPr\"\n                      },\n                      {\n                        \"type\": \"null\"\n                      }\n                    ]\n                  },\n                  \"note\": {\n                    \"anyOf\": [\n                      {\n                        \"$ref\": \"#/$defs/ceremonyText\"\n                      },\n                      {\n                        \"type\": \"null\"\n                      }\n                    ]\n                  }\n                }\n              }\n            }\n          }\n        }\n      }\n    }\n  }\n}\n";
	const file = join(checkout, STATE_SCHEMA_PATH);
	const git = new StateGit(checkout, STATE_SCHEMA_PATH);
	try {
		const sha = options.sha ?? (await readStampIn(dirname(fileURLToPath(import.meta.url))))?.sha ?? "";
		const message = `${COMMIT_SUBJECT}${sha ? ` ${sha}` : ""}`;
		const appDir = options.appDir ?? appRootOf(import.meta.url);
		return await withFileLock(join(options.runtimeDir ?? `${checkout}.runtime`, "state.lock"), async () => {
			const before = await readFile(file, "utf8").catch((error) => {
				if (missing(error)) return void 0;
				throw error;
			});
			if (before === schema) return {
				outcome: "unchanged",
				message: "The state checkout's schema matches this build."
			};
			if (await git.dirty() || await git.busy()) return {
				outcome: "dirty",
				message: `The state checkout has uncommitted changes or an unfinished rebase or merge, so Indra did not update ${STATE_SCHEMA_PATH}; commit or discard them, then restart Indra.`
			};
			const recorded = new RegExp(`^${COMMIT_SUBJECT} ([0-9a-f]{40})$`).exec(await git.lastSubject())?.[1];
			if (recorded) {
				const includes = sha ? await isAncestor(appDir, recorded, sha) : void 0;
				if (includes === false) return {
					outcome: "skipped",
					message: `The state checkout's schema was written by Indra ${recorded.slice(0, 7)}, which this build (${sha.slice(0, 7)}) does not include; Indra left it alone.`
				};
				if (includes === void 0) return {
					outcome: "skipped",
					message: `Could not tell whether this build includes Indra ${recorded.slice(0, 7)}, which wrote the state checkout's schema; Indra left it alone.`
				};
			}
			await mkdir(dirname(file), { recursive: true });
			const temp = `${file}.${randomUUID()}.tmp`;
			await writeFile(temp, schema, { flag: "wx" });
			await rename(temp, file);
			try {
				await git.add();
				await git.commit(message);
			} catch (error) {
				if (before === void 0) await rm(file, { force: true });
				else await writeFile(file, before);
				await git.unstage();
				throw error;
			}
			const sync = await new StateGit(checkout).sync();
			return {
				outcome: "committed",
				message: `Committed "${message}" in the state checkout. ${sync.message}`,
				sync
			};
		});
	} catch (error) {
		return {
			outcome: "error",
			message: `Could not update the state schema: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`
		};
	}
}
//#endregion
export { STATE_SCHEMA_PATH, syncStateSchema };
