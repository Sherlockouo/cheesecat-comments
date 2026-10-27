#!/usr/bin/env node
/**
 * Hides unwanted giscus comments. Copy this file and moderate.yml into the
 * public comments repository (see docs/comments.md); it has no dependencies.
 *
 * - On a `discussion_comment` event it judges just that comment.
 * - Otherwise (schedule, manual run) it sweeps the 50 most recently updated discussions.
 *
 * A comment that trips a rule is minimized (folded as spam or abuse) through
 * the GraphQL API, never deleted, so a maintainer can unfold it on GitHub.
 * Env: GITHUB_TOKEN (discussions: write), GITHUB_REPOSITORY or GISCUS_REPO
 * (owner/name), optional MODERATION_BLOCKLIST (extra words, comma or newline
 * separated), DRY_RUN=1 to only report.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ABUSE = ["傻逼", "傻b", "煞笔", "沙比", "脑残", "弱智", "去死", "操你", "草你", "草泥马", "你妈", "狗日", "滚出", "nmsl", "cnm", "fuckyou", "motherfucker", "retard"];
const SPAM = ["加微信", "加v", "vx号", "微信号", "加qq", "qq群", "加群", "telegram", "whatsapp", "博彩", "赌场", "菠菜", "彩票", "约炮", "色情", "代开发票", "刷单", "日结", "贷款", "代写", "代考", "破解版下载"];
const SHORTENERS = /\b(?:bit\.ly|t\.cn|tinyurl\.com|is\.gd|goo\.gl|ow\.ly|dwz\.cn|url\.cn|t\.me)\//i;

/** Folds spacing and filler between characters, so "傻 逼" and "傻*逼" still match. */
const squash = text => text.normalize("NFKC").toLowerCase().replace(/[\s​-‏﻿*·.,，。_\-|/\\~'"`!！?？]/g, "");

/** @returns {{ verdict: "keep" } | { verdict: "SPAM" | "ABUSE"; reason: string }} */
export function judgeComment(body, extra = []) {
  const text = String(body ?? ""), flat = squash(text);
  const hit = list => list.find(word => word && flat.includes(squash(word)));
  const abuse = hit([...ABUSE, ...extra]);
  if (abuse) return { verdict: "ABUSE", reason: `blocked word: ${abuse}` };
  const spam = hit(SPAM);
  if (spam) return { verdict: "SPAM", reason: `advertising: ${spam}` };
  if (SHORTENERS.test(text)) return { verdict: "SPAM", reason: "shortened link" };
  if ((text.match(/https?:\/\//gi) ?? []).length > 3) return { verdict: "SPAM", reason: "too many links" };
  if (/(.)\1{14,}/u.test(flat)) return { verdict: "SPAM", reason: "repeated characters" };
  if (text.length > 6000) return { verdict: "SPAM", reason: "too long" };
  return { verdict: "keep" };
}

export const parseBlocklist = value => String(value ?? "").split(/[,\n]/).map(word => word.trim()).filter(Boolean);

async function graphql(token, query, variables, fetcher) {
  const response = await fetcher("https://api.github.com/graphql", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "cheesecat-comment-moderation" }, body: JSON.stringify({ query, variables }) });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors?.[0]?.message ?? response.status}`);
  return body.data;
}

const SWEEP = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { discussions(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number comments(last: 50) { nodes { id body isMinimized author { login } replies(last: 50) { nodes { id body isMinimized author { login } } } } } } } } }`;
const MINIMIZE = `mutation($id: ID!, $classifier: ReportedContentClassifiers!) { minimizeComment(input: { subjectId: $id, classifier: $classifier }) { minimizedComment { isMinimized } } }`;

/** Judges the event's comment or sweeps recent discussions; returns what it hid. */
export async function moderate({ token, repo, event = null, extra = [], dryRun = false, fetcher = fetch, log = console.log }) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const [owner, name] = String(repo ?? "").split("/");
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY or GISCUS_REPO must be owner/name");
  let comments;
  if (event?.comment?.node_id) comments = [{ id: event.comment.node_id, body: event.comment.body, isMinimized: false, author: { login: event.comment.user?.login } }];
  else {
    const data = await graphql(token, SWEEP, { owner, name }, fetcher);
    comments = data.repository.discussions.nodes.flatMap(discussion => discussion.comments.nodes.flatMap(comment => [comment, ...comment.replies.nodes]));
  }
  const hidden = [];
  for (const comment of comments) {
    if (comment.isMinimized) continue;
    const result = judgeComment(comment.body, extra);
    if (result.verdict === "keep") continue;
    log(`${dryRun ? "would hide" : "hide"} ${comment.id} by ${comment.author?.login ?? "?"}: ${result.reason}`);
    if (!dryRun) await graphql(token, MINIMIZE, { id: comment.id, classifier: result.verdict }, fetcher);
    hidden.push({ id: comment.id, ...result });
  }
  log(`checked ${comments.length}, hid ${hidden.length}`);
  return hidden;
}

async function main() {
  const env = process.env;
  const event = env.GITHUB_EVENT_NAME === "discussion_comment" && env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) : null;
  await moderate({ token: env.GITHUB_TOKEN, repo: env.GISCUS_REPO || env.GITHUB_REPOSITORY, event, extra: parseBlocklist(env.MODERATION_BLOCKLIST), dryRun: env.DRY_RUN === "1" });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
