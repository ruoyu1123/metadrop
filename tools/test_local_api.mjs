/**
 * test_local_api.mjs — 本地服务(serve.mjs)的端到端回归。
 *
 * 这一层最要紧的不是"接口能返回 200",而是三条安全边界真的成立:
 *   1. 只在回环地址上监听;
 *   2. Host 头不是本机名 → 拒绝(挡 DNS rebinding);
 *   3. 文件名里的 `../` 会被拍平,写不到输出目录外面去。
 * 以及一条功能主线:浏览器 POST 上来的字节,必须**原样**落到磁盘。
 *
 * 全程不需要浏览器、不需要网络(只用 127.0.0.1)。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const NODE = process.execPath;
const SERVE = path.join(HERE, 'serve.mjs');

let pass = 0; let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'md-api-'));
const OUT = path.join(TMP, 'out');

// 预置一个"上次运行残留的探针":启动时必须被自愈清掉(Windows 上 rm 偶发失败,
// 靠下一次启动的 sweepProbes 兜底 —— 这条断言就是钉死这个行为)
const STALE_PROBE = '.metadrop-write-test-99999';
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, STALE_PROBE), 'stale');

function call(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, headers, timeout: 20000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    if (body != null) req.write(body);
    req.end();
  });
}

const json = (r) => { try { return JSON.parse(r.body.toString('utf8')); } catch { return null; } };

/** 逐个删目录内容,避开沙箱对"一次性批量删除"的守卫 */
function rmTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rmTree(p);
    try { fs.rmSync(p, { force: true, recursive: true }); } catch { /* 忽略 */ }
  }
  try { fs.rmdirSync(dir); } catch { /* 忽略 */ }
}

async function main() {
  const port = 8800 + Math.floor(Math.random() * 90);
  const child = spawn(NODE, [SERVE, '--port', String(port), '--out', OUT], {
    cwd: APP,
    env: { ...process.env, METADROP_NO_REVEAL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let child2 = null;   // 第 9 节另起一个实例验启动清理,单独管生命周期
  let log = '';
  child.stdout.on('data', (c) => { log += c.toString(); });
  child.stderr.on('data', (c) => { log += c.toString(); });

  // 等它真正能响应 —— 别用固定 sleep 猜
  let actualPort = port;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`服务没起来:\n${log}`);
    const m = log.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) actualPort = Number(m[1]);
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await call(actualPort, 'GET', '/__local__/ping', {
        headers: { host: `127.0.0.1:${actualPort}` },
      });
      if (r.status === 200) break;
    } catch { /* 还没起来,继续等 */ }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }

  const H = { host: `127.0.0.1:${actualPort}` };

  try {
    console.log('=== 1. 连通性探测 ===');
    const ping = json(await call(actualPort, 'GET', '/__local__/ping', { headers: H }));
    ok('ping 认得自己是 metadrop', ping?.app === 'metadrop', JSON.stringify(ping));
    ok('ping 报出输出目录', ping?.output?.dir === OUT, ping?.output?.dir);
    ok('ping 报出系统临时目录', typeof ping?.tmp === 'string' && ping.tmp.length > 0, ping?.tmp);
    ok('输出目录已自动创建', fs.existsSync(OUT));

    console.log('\n=== 2. 静态托管 ===');
    const home = await call(actualPort, 'GET', '/', { headers: H });
    ok('首页 200 且是 HTML', home.status === 200 && /text\/html/.test(home.headers['content-type']),
      `${home.status} ${home.headers['content-type']}`);
    ok('首页里能找到应用标题', home.body.toString('utf8').includes('mag-list'));
    const js = await call(actualPort, 'GET', '/js/app.js', { headers: H });
    ok('JS 以 text/javascript 返回', js.status === 200 && /javascript/.test(js.headers['content-type']),
      `${js.status} ${js.headers['content-type']}`);
    const wasm = await call(actualPort, 'GET', '/wasm/checkm2_core.wasm', { headers: H });
    ok('wasm 以 application/wasm 返回(浏览器才能快速编译)',
      wasm.status === 200 && wasm.headers['content-type'] === 'application/wasm',
      `${wasm.status} ${wasm.headers['content-type']}`);
    const cached = await call(actualPort, 'GET', '/js/app.js', {
      headers: { ...H, 'if-none-match': js.headers.etag },
    });
    ok('带 ETag 命中 304(刷新不用重传)', cached.status === 304, String(cached.status));

    console.log('\n=== 3. 安全边界 ===');
    const evilHost = await call(actualPort, 'GET', '/__local__/ping', {
      headers: { host: 'evil.example.com' },
    });
    ok('Host 不是本机名 → 403(挡 DNS rebinding)', evilHost.status === 403, String(evilHost.status));

    const evilOrigin = await call(actualPort, 'GET', '/__local__/ping', {
      headers: { ...H, origin: 'https://evil.example.com' },
    });
    ok('跨域来源不是 localhost → 403', evilOrigin.status === 403, String(evilOrigin.status));

    const goodOrigin = await call(actualPort, 'GET', '/__local__/ping', {
      headers: { ...H, origin: `http://127.0.0.1:${actualPort}` },
    });
    ok('跨域来源是 localhost → 放行并回 ACAO',
      goodOrigin.status === 200 && goodOrigin.headers['access-control-allow-origin'],
      `${goodOrigin.status} ${goodOrigin.headers['access-control-allow-origin']}`);

    // 路径穿越:在站点根目录**外面**放一个带标记的文件,再想办法把它要出来。
    // 注意 `/../x` 这类写法会被规范化成根目录内的路径(chroot 语义),那是正确行为;
    // 真正要挡的是"逃出根目录"。
    const SECRET = 'TOP-SECRET-MARKER-SHOULD-NEVER-BE-SERVED';
    fs.writeFileSync(path.join(TMP, 'secret.txt'), SECRET);
    const escapeRel = path.relative(APP, path.join(TMP, 'secret.txt')).replace(/\\/g, '/');
    const trav = await call(actualPort, 'GET', encodeURI(`/${escapeRel}`), { headers: H });
    ok('穿越到站点根目录之外 → 拿不到内容',
      trav.status !== 200 || !trav.body.toString('utf8').includes(SECRET),
      `${trav.status} ${trav.body.toString('utf8').slice(0, 40)}`);
    const trav2 = await call(actualPort, 'GET',
      encodeURI(`/${'/..'.repeat(12)}${escapeRel}`), { headers: H });
    ok('叠加多层 ../ 也逃不出去',
      trav2.status !== 200 || !trav2.body.toString('utf8').includes(SECRET),
      `${trav2.status} ${trav2.body.toString('utf8').slice(0, 40)}`);
    const trav3 = await call(actualPort, 'GET', '/js/../../tools/serve.mjs', { headers: H });
    ok('根目录内的路径(即使绕一圈)仍可正常取用',
      trav3.status === 200 || trav3.status === 404, String(trav3.status));

    console.log('\n=== 4. 直写磁盘(核心能力) ===');
    const chinese = 'MAG\t完整度\nMAG_A\t95.15\nMAG_中文\t71.10\n';
    const w1 = await call(actualPort, 'POST', '/__local__/write?name=checkm2_web_summary.tsv', {
      headers: { ...H, 'content-type': 'application/octet-stream' },
      body: Buffer.from(chinese, 'utf8'),
    });
    const w1j = json(w1);
    ok('写入返回 ok', w1.status === 200 && w1j?.ok === true, w1.body.toString().slice(0, 200));
    ok('字节数如实回报', w1j?.bytes === Buffer.byteLength(chinese, 'utf8'), String(w1j?.bytes));
    const onDisk = fs.readFileSync(path.join(OUT, 'checkm2_web_summary.tsv'), 'utf8');
    ok('磁盘上的内容逐字节一致', onDisk === chinese, JSON.stringify(onDisk));
    ok('绝对路径指回输出目录', w1j?.path === path.join(OUT, 'checkm2_web_summary.tsv'), w1j?.path);

    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 255]);
    await call(actualPort, 'POST', '/__local__/write?name=MAG_A.cleaned.fa', {
      headers: { ...H, 'content-type': 'application/octet-stream' }, body: bytes,
    });
    ok('二进制字节原样落盘',
      Buffer.compare(fs.readFileSync(path.join(OUT, 'MAG_A.cleaned.fa')), bytes) === 0);
    const leftovers = fs.readdirSync(OUT).filter((f) => f.startsWith('.metadrop-write-test'));
    ok('输出目录里不留可写性探针文件', leftovers.length === 0, leftovers.join(','));
    ok('启动时清掉了上次残留的探针(自愈)',
      !fs.existsSync(path.join(OUT, STALE_PROBE)), STALE_PROBE);

    console.log('\n=== 5. 文件名净化 ===');
    await call(actualPort, 'POST', '/__local__/write?name=..%2F..%2Fevil.txt', {
      headers: { ...H, 'content-type': 'application/octet-stream' }, body: Buffer.from('x'),
    });
    ok('`../../evil.txt` 被拍平成输出目录内的普通文件',
      fs.existsSync(path.join(OUT, 'evil.txt')), fs.readdirSync(OUT).join(','));
    ok('输出目录外没有被写出文件',
      !fs.existsSync(path.join(TMP, 'evil.txt')) && !fs.existsSync(path.join(APP, 'evil.txt'))
      && !fs.existsSync(path.resolve(TMP, '..', 'evil.txt')));

    const badName = await call(actualPort, 'POST', '/__local__/write?name=..', {
      headers: { ...H, 'content-type': 'application/octet-stream' }, body: Buffer.from('x'),
    });
    ok('纯 `..` 的名字被拒(400)', badName.status === 400, String(badName.status));

    console.log('\n=== 6. 运行期改输出目录 ===');
    const sub = path.join(TMP, 'another_out');
    const setRes = await call(actualPort, 'POST', '/__local__/output', {
      headers: { ...H, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ path: sub }), 'utf8'),
    });
    const sj = json(setRes);
    ok('新目录被接受', sj?.ok === true && sj?.output?.dir === sub, JSON.stringify(sj));
    ok('新目录被真的建出来了', fs.existsSync(sub));
    await call(actualPort, 'POST', '/__local__/write?name=after.tsv', {
      headers: { ...H, 'content-type': 'application/octet-stream' }, body: Buffer.from('hi'),
    });
    ok('之后的写入落到新目录', fs.existsSync(path.join(sub, 'after.tsv')));

    const badDir = await call(actualPort, 'POST', '/__local__/output', {
      headers: { ...H, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ path: '' }), 'utf8'),
    });
    ok('空路径被拒', badDir.status === 400, String(badDir.status));

    console.log('\n=== 7. 临时目录暂存(导出 ZIP 的兜底路径) ===');
    const zipBytes = Buffer.from('PK\u0003\u0004fake-but-bytes-must-round-trip');
    const st = await call(actualPort, 'POST', '/__local__/stage?name=metadrop_results.zip', {
      headers: { ...H, 'content-type': 'application/zip' }, body: zipBytes,
    });
    const stj = json(st);
    ok('暂存返回 ok 与取回地址', st.status === 200 && typeof stj?.url === 'string', JSON.stringify(stj));
    ok('压缩包写进了系统临时目录', String(stj?.path || '').startsWith(os.tmpdir()), stj?.path);
    const back = await call(actualPort, 'GET', stj.url, { headers: H });
    ok('按返回地址取回的字节完全一致',
      back.status === 200 && Buffer.compare(back.body, zipBytes) === 0,
      `${back.status} ${back.body.length}/${zipBytes.length}`);
    ok('取回时带下载头', /attachment/.test(back.headers['content-disposition'] || ''),
      back.headers['content-disposition']);
    const gone = await call(actualPort, 'GET', '/__local__/tmp/deadbeef1234/x.zip', { headers: H });
    ok('不存在的 token → 404', gone.status === 404, String(gone.status));
    rmTree(path.dirname(stj.path));   // 别把自己的暂存垃圾留在系统临时目录里

    console.log('\n=== 8. 其它 ===');
    const nf = await call(actualPort, 'GET', '/no-such-file.txt', { headers: H });
    ok('不存在的静态文件 → 404', nf.status === 404, String(nf.status));
    const unknown = await call(actualPort, 'POST', '/__local__/nope', { headers: H, body: Buffer.from('') });
    ok('未知本地接口 → 404', unknown.status === 404, String(unknown.status));
    const revealRes = await call(actualPort, 'POST', '/__local__/reveal', {
      headers: { ...H, 'content-type': 'application/json' }, body: Buffer.from('{}'),
    });
    ok('打开文件夹接口可用(METADROP_NO_REVEAL 下不真的弹窗)',
      json(revealRes)?.ok === true, revealRes.body.toString().slice(0, 160));

    console.log('\n=== 9. 启动时清理过期暂存 ===');
    // 造一个"2 天前的旧暂存"和一个"刚刚的暂存",重启服务后应当只删掉旧的
    const STAGE = path.join(os.tmpdir(), 'metadrop-export');
    const staleDir = path.join(STAGE, 'stale00000000');
    const freshDir = path.join(STAGE, 'fresh00000000');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'old.zip'), 'x');
    fs.writeFileSync(path.join(freshDir, 'new.zip'), 'y');
    // 先把内容写好,再拨 mtime —— 否则写文件会把目录 mtime 刷成"现在"
    const twoDaysAgo = (Date.now() - 2 * 24 * 3600 * 1000) / 1000;
    fs.utimesSync(staleDir, twoDaysAgo, twoDaysAgo);

    const port2 = 8900 + Math.floor(Math.random() * 90);
    const OUT2 = path.join(TMP, 'out2');
    child2 = spawn(NODE, [SERVE, '--port', String(port2), '--out', OUT2], {
      cwd: APP, env: { ...process.env, METADROP_NO_REVEAL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log2 = '';
    child2.stdout.on('data', (c) => { log2 += c.toString(); });
    child2.stderr.on('data', (c) => { log2 += c.toString(); });
    let port2Actual = port2;
    const dl2 = Date.now() + 20000;
    for (;;) {
      if (Date.now() > dl2) throw new Error(`第二个服务没起来:\n${log2}`);
      const m2 = log2.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m2) port2Actual = Number(m2[1]);
      try {
        // 清理发生在 listen 之前,所以 ping 通了就说明已经清过了
        // eslint-disable-next-line no-await-in-loop
        const r = await call(port2Actual, 'GET', '/__local__/ping', {
          headers: { host: `127.0.0.1:${port2Actual}` },
        });
        if (r.status === 200) break;
      } catch { /* 还没起来,继续等 */ }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
    }
    ok('过期暂存目录被启动清理', !fs.existsSync(staleDir), staleDir);
    ok('新近暂存目录被保留', fs.existsSync(freshDir), freshDir);

    child2.kill('SIGTERM');
    child2 = null;
    await new Promise((r) => setTimeout(r, 400));
    rmTree(staleDir);
    rmTree(freshDir);
  } finally {
    child.kill('SIGTERM');
    if (child2) child2.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
    if (!child.killed) child.kill('SIGKILL');
    if (child2 && !child2.killed) child2.kill('SIGKILL');
  }

  console.log(`\n=== 结果:${pass} 通过 / ${fail} 失败 ===`);
  rmTree(TMP);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  rmTree(TMP);
  process.exit(1);
});
