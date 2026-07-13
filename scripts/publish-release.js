#!/usr/bin/env node
/*
 * publish-release.js — 一鍵把 main 的最新內容同步發布到 release 分支。
 *
 * 用法：node scripts/publish-release.js
 *
 * 流程：build-release 產 dist/release → 用 worktree 檢出 release 分支 →
 *   以 dist 內容覆蓋 → 有變更才 commit + push origin release → 清 worktree。
 * 沒有實質變更時直接跳過（不會產生空 commit）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO   = path.resolve(__dirname, '..');
const DIST   = path.join(REPO, 'dist', 'release');
const BRANCH = 'release';
const WT     = path.join(os.tmpdir(), `agumon-release-publish-${process.pid}`);

function git(args, cwd = REPO) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}
function tryGit(args, cwd = REPO) { try { return git(args, cwd); } catch (e) { return null; } }

function cleanup() {
    if (tryGit(['worktree', 'remove', '--force', WT]) === null) {
        tryGit(['worktree', 'prune']);
        try { fs.rmSync(WT, { recursive: true, force: true }); } catch (_) {}
    }
}

function main() {
    // 提醒：build 讀「工作區」，未提交的 shipped 變動也會進 release
    if (git(['status', '--porcelain']).trim()) {
        console.warn('⚠ 工作區有未提交變動 → release 會反映工作區內容（非最後 commit）。建議先 commit main。\n');
    }

    console.log('[1/5] 產出 dist/release …');
    execFileSync('node', [path.join(REPO, 'scripts', 'build-release.js')], { cwd: REPO, stdio: 'inherit' });

    const mainRef = git(['rev-parse', '--short', 'HEAD']).trim();

    console.log('\n[2/5] 準備 release worktree …');
    tryGit(['fetch', 'origin', BRANCH]);
    tryGit(['worktree', 'remove', '--force', WT]);   // 清殘留
    const hasLocal = tryGit(['rev-parse', '--verify', `refs/heads/${BRANCH}`]) !== null;
    if (hasLocal) git(['worktree', 'add', '--force', WT, BRANCH]);
    else          git(['worktree', 'add', '--force', '-B', BRANCH, WT, `origin/${BRANCH}`]);
    tryGit(['reset', '--hard', `origin/${BRANCH}`], WT);   // 對齊遠端 tip（有人先推過也不覆蓋）

    console.log('[3/5] 以 dist 內容覆蓋 …');
    tryGit(['rm', '-rf', '.'], WT);                  // 清舊 tracked（.git 指標保留）
    fs.cpSync(DIST, WT, { recursive: true });
    git(['add', '-A'], WT);

    // 有無實質變更
    const noChange = tryGit(['diff', '--cached', '--quiet'], WT) !== null;
    if (noChange) {
        console.log('\n[4/5] release 已是最新，無變更 → 不 commit/push。');
        cleanup();
        console.log('\n✅ 完成（release 未變動）。');
        return;
    }

    const msg =
`release：同步 main (${mainRef})

由 scripts/publish-release.js 自動產出。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;
    git(['commit', '-m', msg], WT);
    console.log('\n[4/5] 已 commit。');

    console.log('[5/5] push origin release …');
    git(['push', 'origin', BRANCH], WT);
    cleanup();
    console.log(`\n✅ release 已同步到 main (${mainRef}) 並 push。`);
}

try { main(); }
catch (e) { cleanup(); console.error('\n✗ 發布失敗：' + (e.message || e)); process.exit(1); }
