'use strict';

/*
 * Trae CN 签到助手（唯一入口）
 *
 *   node src/trae.js             进入菜单
 *   node src/trae.js --login     直接添加账号
 *   node src/trae.js --checkin   非交互签到（供计划任务调用）
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const engine = require('./auth-engine');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'TraeAccounts');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'TraeSignCenter.log');

const API_BASE = 'https://api.trae.cn/trae/api/v2/ug/checkin_credits';
const API_ENTITLEMENT = 'https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list';
const REQ_SOURCE = 1;
const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';

const COLOR = process.stdout.isTTY;
const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const cyan = t => paint('36', t);
const green = t => paint('32', t);
const red = t => paint('31', t);
const yellow = t => paint('33', t);
const gray = t => paint('90', t);

const WIDTH = 46;
const RULE = '='.repeat(WIDTH);
const SUB_RULE = '-'.repeat(WIDTH);

function banner(text) {
    console.log('');
    console.log(cyan(RULE));
    console.log(cyan(`  ${text}`));
    console.log(cyan(RULE));
}

function section(text) {
    console.log('');
    console.log(cyan(`  ${text}`));
    console.log(cyan(SUB_RULE));
}

function ok(text) { console.log(green(`  √ ${text}`)); }
function fail(text) { console.log(red(`  × ${text}`)); }
function warn(text) { console.log(yellow(`  ! ${text}`)); }
function note(text) { console.log(gray(`    ${text}`)); }

let rl = null;
let rlClosed = false;
function getRl() {
    if (!rl) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.on('close', () => { rlClosed = true; });
    }
    return rl;
}
function ask(question) {
    if (rlClosed) return Promise.resolve('');
    const current = getRl();
    return new Promise(resolve => {
        try {
            current.question(question, answer => resolve(answer.trim()));
        } catch (e) {
            resolve('');
        }
    });
}
function closeRl() {
    if (rl && !rlClosed) rl.close();
    rl = null;
    rlClosed = true;
}

// 等待任意按键（供计划任务结束后停留窗口使用）
function waitAnyKey(prompt) {
    return new Promise(resolve => {
        if (!process.stdin.isTTY) {
            console.log(prompt);
            resolve();
            return;
        }
        process.stdout.write(prompt);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once('data', () => {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write('\n');
            resolve();
        });
    });
}

// ---------------- 日志 ----------------
function ensureDirs() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function trimLog() {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
        fs.writeFileSync(LOG_FILE, '');
    }
}

function stamp(date) {
    const p = n => String(n).padStart(2, '0');
    return {
        time: `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`,
        full: `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
    };
}

function log(message, color) {
    const now = new Date();
    const s = stamp(now);
    const line = color ? color(message) : message;
    console.log(`[${s.time}] ${line}`);
    fs.appendFileSync(LOG_FILE, `[${s.full}] ${message}\r\n`, 'utf8');
}

// ---------------- 通用工具 ----------------
function formatNumber(value, digits) {
    return Number(value || 0).toLocaleString('en-US', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
}

function formatLocal(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const s = stamp(d);
    return s.full.slice(0, 16);
}

function accountFiles() {
    if (!fs.existsSync(DATA_DIR)) return [];
    return fs.readdirSync(DATA_DIR)
        .filter(name => name.toLowerCase().endsWith('.json') && !name.toLowerCase().endsWith('.device.json'))
        .sort()
        .map(name => path.join(DATA_DIR, name));
}

function nextAccountName() {
    let max = 0;
    for (const file of accountFiles()) {
        const m = path.basename(file).match(/^号(\d+)\.json$/);
        if (m) max = Math.max(max, Number(m[1]));
    }
    return `号${max + 1}`;
}

function lastCheckinLabel() {
    try {
        if (!fs.existsSync(LOG_FILE)) return '暂无记录';
        const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i--) {
            const m = lines[i].match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}):\d{2}\]\s+.*(今日已签到|签到成功)/);
            if (m) return m[1];
        }
    } catch (e) { /* 忽略日志读取异常 */ }
    return '暂无记录';
}

function randomHex(length) {
    let out = '';
    while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
    return out.slice(0, length);
}

// ---------------- 添加账号 ----------------
async function addAccounts() {
    banner('Trae CN 签到助手 - 添加账号');
    note(`当前共有 ${accountFiles().length} 个账号。每个账号只需登录一次，之后自动续期。`);
    note('登录将在浏览器中完成，支持扫码或短信验证，请不要关闭本窗口。');

    let added = 0;
    while (true) {
        const defaultName = nextAccountName();
        console.log('');
        const input = await ask(`  请输入账号备注名（直接回车使用 ${defaultName}）: `);
        if (rlClosed) break;
        const name = input || defaultName;

        if (/[\\/:*?"<>|]/.test(name)) {
            fail('名称包含非法字符 \\ / : * ? " < > |，请重新输入。');
            continue;
        }

        const file = path.join(DATA_DIR, `${name}.json`);
        if (fs.existsSync(file)) {
            const answer = await ask(`  账号 [${name}] 已存在，是否覆盖登录态？(y/N): `);
            if (rlClosed) break;
            if (!/^y/i.test(answer)) {
                warn(`已跳过 ${name}，请换一个名称。`);
                continue;
            }
        }

        console.log('');
        warn('正在打开浏览器，请在页面中完成登录（扫码或短信）...');
        note('登录完成后本窗口会自动继续；如 5 分钟内未完成，登录回调会超时。');

        try {
            const result = await engine.doLogin({ file, name });
            const who = result.email ? `${result.username} <${result.email}>` : result.username;
            ok(`登录成功: ${who || '（未获取到昵称）'}`);
            note(`账号文件 : ${path.relative(ROOT, result.file)}`);
            note(`有效期至 : ${formatLocal(result.expiredAt)}`);
            note(`设备标识 : ${result.deviceId}`);
            note('之后由脚本自动续期，无需再次登录。');
            added++;
        } catch (e) {
            fail(`登录失败: ${e.message}`);
            note('建议：重新运行一次，并确保在浏览器中 5 分钟内完成登录。');
            if (e.detail && e.detail.raw) {
                warn('回调原始参数（排查用）:');
                note(e.detail.raw);
            }
        }

        console.log('');
        const again = await ask('  继续添加下一个账号？(Y/n): ');
        if (rlClosed || /^n/i.test(again)) break;
    }

    console.log('');
    if (added > 0) {
        ok(`本次添加 ${added} 个账号，当前共 ${accountFiles().length} 个。`);
    } else {
        warn('本次未添加新账号。');
    }
}

// ---------------- 提取信息 ----------------
function defaultStoragePath() {
    return path.join(process.env.APPDATA || '', 'Trae CN', 'User', 'globalStorage', 'storage.json');
}

// 解析用户输入的登录态路径：支持 %变量%、引号、文件路径或多层目录
function resolveStoragePath(raw) {
    let p = (raw || '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (!p) p = defaultStoragePath();
    p = p.replace(/%([^%]+)%/g, (m, name) => (process.env[name] !== undefined ? process.env[name] : m));
    p = path.resolve(p);

    if (!fs.existsSync(p)) return null;
    if (fs.statSync(p).isFile()) return /\.json$/i.test(p) ? p : null;

    const candidates = [
        path.join(p, 'User', 'globalStorage', 'storage.json'),
        path.join(p, 'globalStorage', 'storage.json'),
        path.join(p, 'storage.json')
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

function normalizeAccountName(raw) {
    return (raw || '').trim().replace(/\.device\.json$/i, '').replace(/\.json$/i, '');
}

// 从客户端登录态中取出 token、设备ID、机器码与设备密钥
function readClientLogin(storage) {
    const tokenBlob = storage[AUTH_KEY];
    if (!tokenBlob) return { error: '客户端当前未登录（缺少 iCubeAuthInfo://icube.cloudide），请先在客户端登录。' };

    // 设备ID藏在键名 iCubeAuthInfo://icube-dc:<数字> 里，值里是设备密钥对
    const deviceKey = Object.keys(storage).find(k => k.startsWith('iCubeAuthInfo://icube-dc:'));
    if (!deviceKey) return { error: '客户端登录态中没有设备信息（iCubeAuthInfo://icube-dc），请先在客户端登录。' };

    const deviceId = String(deviceKey.split(':').pop()).trim();
    const machineId = String(storage['telemetry.machineId'] || '').trim();
    if (!machineId) return { error: '客户端登录态中缺少 telemetry.machineId，无法提取。' };

    let deviceKeys = null;
    try {
        const dc = engine.decryptAuth(storage[deviceKey]);
        if (dc && dc.privateKeyPEM && dc.publicKeyPEM) {
            deviceKeys = { privateKey: dc.privateKeyPEM, publicKey: dc.publicKeyPEM };
        }
    } catch (e) { /* 下面统一提示 */ }
    if (!deviceKeys) return { error: '无法解析客户端设备密钥，续期将不可用。' };

    let auth = null;
    try {
        auth = engine.decryptAuth(tokenBlob);
    } catch (e) { /* 下面统一提示 */ }
    if (!auth || !auth.token) return { error: '客户端登录态无法解析，请重新登录客户端后再试。' };

    return { tokenBlob, deviceId, machineId, deviceKeys, auth };
}

async function extractAccountInfo() {
    banner('Trae CN 签到助手 - 提取信息');

    const fallbackPath = defaultStoragePath();
    console.log('');
    const pathInput = await ask(`  请输入客户端登录态路径（回车使用默认）:\n  ${fallbackPath}\n  > `);
    if (rlClosed) return;

    const storagePath = resolveStoragePath(pathInput);
    if (!storagePath) {
        fail('未找到客户端登录态文件，请检查路径（需指向 storage.json 或其上级目录）。');
        return;
    }
    note(`读取来源 : ${storagePath}`);

    let storage;
    try {
        storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
    } catch (e) {
        fail('客户端登录态文件无法解析，可能已损坏。');
        return;
    }

    const info = readClientLogin(storage);
    if (info.error) {
        fail(info.error);
        return;
    }
    const { tokenBlob, deviceId, machineId, deviceKeys, auth } = info;

    section('提取到的信息');
    console.log(`  账号     : ${(auth.account && auth.account.username) || '未知'}`);
    console.log(`  用户ID   : ${auth.userId || '未知'}`);
    console.log(`  设备ID   : ${deviceId}`);
    console.log(`  机器码   : ${machineId}`);
    console.log(`  有效期至 : ${formatLocal(auth.expiredAt)}`);
    if (!/^\d{15}$/.test(deviceId)) {
        warn('设备ID不是 15 位纯数字，签到接口可能判定为非法设备（9074）。');
    }
    if (auth.expiredAt && new Date(auth.expiredAt).getTime() < Date.now()) {
        warn('客户端登录态已过期，请先在客户端重新登录后再提取。');
    }

    const accounts = accountFiles().map(f => path.basename(f, '.json'));
    const fallback = accounts.length > 0 ? accounts[0] : '号1';
    console.log('');
    const input = await ask(`  请输入保存名称（对应账号文件名，直接回车使用 ${fallback}）: `);
    if (rlClosed) return;

    const name = normalizeAccountName(input) || fallback;
    if (/[\\/:*?"<>|]/.test(name)) {
        fail('名称包含非法字符 \\ / : * ? " < > |，已取消。');
        return;
    }

    const accountFile = path.join(DATA_DIR, `${name}.json`);
    const deviceFile = path.join(DATA_DIR, `${name}.device.json`);
    const existing = [accountFile, deviceFile].filter(f => fs.existsSync(f));
    if (existing.length > 0) {
        const list = existing.map(f => path.basename(f)).join('、');
        const answer = await ask(`  ${list} 已存在，是否覆盖？(y/N): `);
        if (rlClosed) return;
        if (!/^y/i.test(answer)) {
            warn('已取消，未做任何修改。');
            return;
        }
    }

    // 设备信息：token 与本设备同源，无需 token_device_id
    fs.writeFileSync(deviceFile, JSON.stringify({ device_id: deviceId, machine_id: machineId }, null, 2) + '\n', 'utf8');

    // 账号信息：原样沿用客户端登录态 + 客户端设备密钥，续期时可与登录态匹配
    const accountStorage = {
        [AUTH_KEY]: tokenBlob,
        traeSignCenter: {
            publicKey: deviceKeys.publicKey,
            privateKey: deviceKeys.privateKey,
            consoleHost: engine.CONFIG.consoleHost,
            apiHost: engine.CONFIG.apiHost,
            clientId: engine.CONFIG.clientId,
            source: 'client',
            extractedFrom: storagePath,
            extractedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }
    };
    fs.writeFileSync(accountFile, JSON.stringify(accountStorage, null, 2), 'utf8');

    ok(`已保存 : TraeAccounts\\${name}.json（登录态与设备密钥）`);
    ok(`已保存 : TraeAccounts\\${name}.device.json（设备ID与机器码）`);
    note('该账号直接沿用客户端登录态，无需在浏览器中登录。');
    warn('与客户端共用同一登录态：任一方续期都会刷新令牌，另一方需重新提取。');
}

// ---------------- 签到 ----------------
async function apiPost(url, token, region, deviceId, machineId) {
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Cloud-IDE-JWT ${token}`,
        'x-device-id': deviceId,
        'X-Machine-Id': machineId
    };
    if (region) headers['X-User-Region'] = region;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ req_source: REQ_SOURCE })
        });
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            return null;
        }
    } catch (e) {
        return null;
    }
}

// 签到接口只认 15 位纯数字的设备ID（aha 体系），旧版 hex 会被判为非法设备
const DEVICE_ID_RE = /^\d{15}$/;

function newDeviceId() {
    return String(Math.floor(1e14 + Math.random() * 9e14));
}

function readDevice(fileName) {
    const deviceFile = path.join(DATA_DIR, fileName.replace(/\.json$/i, '.device.json'));

    let deviceId = '';
    let machineId = '';
    let tokenDeviceId = '';
    if (fs.existsSync(deviceFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
            if (data.device_id && data.machine_id) {
                deviceId = String(data.device_id);
                machineId = String(data.machine_id);
                tokenDeviceId = String(data.token_device_id || '');
            }
        } catch (e) { /* 损坏则重建 */ }
    }

    // 没有可用设备信息：新建
    if (!deviceId || !machineId) {
        const newId = newDeviceId();
        const newMachine = randomHex(32);
        fs.writeFileSync(deviceFile, JSON.stringify({ device_id: newId, machine_id: newMachine }, null, 2) + '\n', 'utf8');
        return { deviceId: newId, machineId: newMachine, created: true, migrated: false };
    }

    // 旧版 hex 设备ID：迁移为 15 位数字ID（幂等，machine_id 原样复用）
    if (!DEVICE_ID_RE.test(deviceId)) {
        const migratedId = newDeviceId();
        const next = { device_id: migratedId, machine_id: machineId };
        // 登录态绑定的仍是旧设备ID，续期时要用它，否则会返回 20403
        next.token_device_id = tokenDeviceId || deviceId;
        fs.writeFileSync(deviceFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
        return { deviceId: migratedId, machineId, created: false, migrated: true };
    }

    return { deviceId, machineId, created: false, migrated: false };
}

function logClientSourceHint(storage) {
    const from = (storage.traeSignCenter && storage.traeSignCenter.extractedFrom) || '';
    log('  ! 该账号登录态提取自客户端，脚本不自动续期', yellow);
    log('  ! 请在 Trae CN 客户端保持登录，然后重新执行「4. 提取信息」', yellow);
    if (from) log(`    来源路径 : ${from}`, gray);
}

async function checkAccount(file, stats, index, total) {
    const fileName = path.basename(file);
    log(`[${index}/${total}] ${fileName}`, cyan);

    try {
        let storage = engine.readAccountFile(file);
        let enc = storage && storage[AUTH_KEY];
        if (!enc) {
            log('  -> 未找到登录态，请在菜单 1 中重新登录该账号', red);
            stats.failed++;
            return;
        }

        let auth;
        try {
            auth = engine.decryptAuth(enc);
        } catch (e) {
            auth = null;
        }
        if (!auth || !auth.token) {
            log('  -> 登录态损坏，请重新登录该账号', red);
            stats.failed++;
            return;
        }

        // 提取自客户端的账号：不自动续期，避免轮换掉客户端的 refreshToken
        const isClientSource = (storage.traeSignCenter && storage.traeSignCenter.source) === 'client';
        const expireAt = auth.expiredAt ? new Date(auth.expiredAt).getTime() : 0;

        if (isClientSource && expireAt && expireAt <= Date.now()) {
            log('  -> 登录态已过期（提取自客户端），跳过本次签到', red);
            logClientSourceHint(storage);
            stats.failed++;
            return;
        }
        if (isClientSource && expireAt && expireAt < Date.now() + 12 * 3600 * 1000) {
            log('  -> 登录态即将过期（提取自客户端，脚本不自动续期）', yellow);
            logClientSourceHint(storage);
        }

        // Token 到期前 12 小时自动续期（提取自客户端的账号不在此列）
        if (!isClientSource && expireAt && expireAt < Date.now() + 12 * 3600 * 1000) {
            log('  -> Token 即将过期，正在自动续期...', yellow);
            try {
                await engine.doRefresh({ file });
                storage = engine.readAccountFile(file);
                auth = engine.decryptAuth(storage[AUTH_KEY]);
                log('  -> 续期成功', green);
            } catch (e) {
                log(`  -> 续期失败: ${e.message}`, red);
            }
        }

        const token = auth.token;
        const region = (auth.userRegion && auth.userRegion.region) || '';
        const device = readDevice(fileName);
        if (device.created) {
            log(`  -> [新建] 已生成独立设备标识: ${fileName}`, yellow);
        }
        if (device.migrated) {
            log('  -> [迁移] 设备标识已升级为 15 位数字ID', yellow);
        }

        const status = await apiPost(`${API_BASE}/status`, token, region, device.deviceId, device.machineId);
        if (!status) {
            log('  -> 获取签到状态失败，请检查网络后重试', red);
            stats.failed++;
            return;
        }

        const ent = await apiPost(API_ENTITLEMENT, token, region, device.deviceId, device.machineId);
        let totalAmount = 0;
        let consumedAmount = 0;
        let remainAmount = 0;
        if (ent && ent.usage_summary) {
            totalAmount = Number(ent.usage_summary.total_amount || 0);
            consumedAmount = Number(ent.usage_summary.consumed_amount || 0);
            remainAmount = totalAmount - consumedAmount;
            stats.totalAmount += totalAmount;
            stats.totalConsumed += consumedAmount;
            stats.totalRemain += remainAmount;
        }
        const usage = `剩余 ${formatNumber(remainAmount, 2)} / 总 ${formatNumber(totalAmount, 0)}`;

        if (status.checked_in) {
            log(`  -> 今日已签到，${usage}`, gray);
            stats.alreadyChecked++;
            return;
        }

        if (!status.enable) {
            log(`  -> 签到不可用: ${status.message || '未返回原因'}`, red);
            if (/authenticate/i.test(String(status.message || ''))) {
                if (isClientSource) {
                    log('  -> 该账号登录态由客户端维护，请重新执行「4. 提取信息」。', yellow);
                } else {
                    log('  -> 登录态已被服务端吊销，请在菜单中重新登录该账号。', yellow);
                }
            }
            stats.failed++;
            return;
        }

        const claim = await apiPost(`${API_BASE}/claim`, token, region, device.deviceId, device.machineId);
        if (claim && Number(claim.code) === 0) {
            let usageAfter = usage;
            const entAfter = await apiPost(API_ENTITLEMENT, token, region, device.deviceId, device.machineId);
            if (entAfter && entAfter.usage_summary) {
                const newTotal = Number(entAfter.usage_summary.total_amount || 0);
                const newConsumed = Number(entAfter.usage_summary.consumed_amount || 0);
                const newRemain = newTotal - newConsumed;
                stats.totalAmount += newTotal - totalAmount;
                stats.totalConsumed += newConsumed - consumedAmount;
                stats.totalRemain += newRemain - remainAmount;
                usageAfter = `剩余 ${formatNumber(newRemain, 2)} / 总 ${formatNumber(newTotal, 0)}`;
            }
            log(`  -> 签到成功，本次 +${status.credits} 积分，${usageAfter}`, green);
            stats.newChecked++;
        } else {
            const message = (claim && claim.message) || '未知错误';
            log(`  -> 签到失败: ${message}`, red);
            if (/9074|参与用户太多/i.test(message)) {
                log('  -> 提示：设备ID非法或未被识别，请确认同目录 .device.json 的 device_id 为 15 位纯数字', yellow);
            } else if (/9095|今日已签到/i.test(message)) {
                log('  -> 提示：该设备今日已签到，明日再来', yellow);
            } else {
                log('  -> 提示：可稍后在客户端确认账号状态', yellow);
            }
            stats.failed++;
        }
    } catch (e) {
        log(`  -> 异常: ${e.message}`, red);
        stats.failed++;
    }
}

async function runCheckin() {
    ensureDirs();
    trimLog();

    const files = accountFiles();
    const stats = {
        total: files.length,
        alreadyChecked: 0,
        newChecked: 0,
        failed: 0,
        totalAmount: 0,
        totalConsumed: 0,
        totalRemain: 0
    };
    const startedAt = Date.now();

    banner('Trae CN 签到助手 - 立即签到');

    if (files.length === 0) {
        warn('尚未添加任何账号，本次签到跳过。');
        note('请返回菜单，选择 1 添加账号后再试。');
        log('扫描结果：0 个账号。', yellow);
        return stats;
    }

    log(`共 ${files.length} 个账号，开始签到...`, yellow);

    for (let i = 0; i < files.length; i++) {
        await checkAccount(files[i], stats, i + 1, files.length);
        console.log('');
        if (i < files.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 800));
        }
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const checkedTotal = stats.alreadyChecked + stats.newChecked;
    const report = [
        '',
        RULE,
        '  今日签到报表',
        RULE,
        `  总账号数  : ${stats.total}`,
        `  签到成功  : ${checkedTotal} (本次新签 ${stats.newChecked})`,
        `  今日已签  : ${stats.alreadyChecked}`,
        `  失败/异常 : ${stats.failed}`,
        SUB_RULE,
        `  总积分池  : ${formatNumber(stats.totalAmount, 0)}`,
        `  总计消耗  : ${formatNumber(stats.totalConsumed, 2)}`,
        `  总剩余额  : ${formatNumber(stats.totalRemain, 2)}`,
        RULE,
        ''
    ].join('\n');

    console.log(cyan(report));
    fs.appendFileSync(LOG_FILE, report + '\r\n', 'utf8');

    if (stats.failed > 0) {
        warn(`有 ${stats.failed} 个账号处理失败，可查看 logs\\TraeSignCenter.log。`);
    } else {
        ok(`全部处理完成，耗时 ${seconds} 秒。`);
    }
    return stats;
}

// ---------------- 自动签到任务 ----------------
function isElevated() {
    const result = spawnSync('fltmc', { stdio: 'ignore' });
    return result.status === 0;
}

function delayLabel(raw) {
    let m = raw.match(/PT(\d+)M/);
    if (m) return `${m[1]} 分钟`;
    m = raw.match(/^(\d+):(\d{2})/);
    if (m) return `${Number(m[1]) * 60 + Number(m[2])} 分钟`;
    return raw || '未知';
}

function taskStatus() {
    const command = "$t=Get-ScheduledTask -TaskName 'TraeSignCenterTask' -ErrorAction SilentlyContinue; if($t){'ON|'+$t.Triggers[0].Delay}else{'OFF'}";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
    const out = String(result.stdout || '').trim();
    if (!out.startsWith('ON')) return { registered: false, delay: '' };
    const raw = out.split('|')[1] || '';
    return { registered: true, delay: delayLabel(raw) };
}

function runTaskScript(script) {
    if (isElevated()) {
        spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit' });
        return;
    }

    warn('正在请求管理员权限，请在 UAC 弹窗中点击“是”...');
    const inner = `-NoProfile -ExecutionPolicy Bypass -File "${script}"`;
    const command = `Start-Process -FilePath 'powershell.exe' -ArgumentList '${inner}' -Verb RunAs -Wait`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
    if (result.status !== 0) {
        warn('已取消或提权失败，计划任务未做修改。');
    }
}

async function taskMenu() {
    const status = taskStatus();

    section('Trae CN 签到助手 - 开机自动签到');
    console.log(`  当前状态 : ${status.registered ? green('已注册') : yellow('未注册')}`);
    if (status.registered) {
        note(`触发方式 : 用户登录后延迟 ${status.delay}`);
        note('如需修改延迟，请选择 1 重新注册。');
    } else {
        note('注册后将在每次登录 Windows 后延迟执行签到。');
    }
    console.log('');
    console.log('  1. 注册 / 更新计划任务');
    console.log('  2. 删除计划任务');
    console.log('  0. 返回');

    const choice = await ask('\n  请选择 [0-2]: ');
    if (rlClosed || choice === '0' || choice === '') return;
    if (choice !== '1' && choice !== '2') {
        warn('无效选项，请输入 0、1 或 2。');
        return;
    }

    const name = choice === '1' ? 'task-setup.ps1' : 'task-remove.ps1';
    const script = path.join(ROOT, 'scripts', name);
    if (!fs.existsSync(script)) {
        fail(`缺少 scripts\\${name}，请检查项目文件是否完整。`);
        return;
    }
    runTaskScript(script);
}

// ---------------- 菜单 ----------------
function renderMenu() {
    banner('Trae CN 签到助手');
    console.log(`  账号数量 : ${accountFiles().length}`);
    console.log(`  上次签到 : ${lastCheckinLabel()}`);
    console.log('');
    console.log('  1. 添加账号');
    console.log('  2. 立即签到');
    console.log('  3. 开机自动签到');
    console.log('  4. 提取信息（账号+设备）');
    console.log('  0. 退出');
    console.log('');
}

async function menu() {
    while (true) {
        renderMenu();
        const choice = await ask('  请选择 [0-4]: ');
        if (rlClosed) break;
        if (choice === '0' || choice === 'q') break;

        if (choice === '1') {
            await addAccounts();
        } else if (choice === '2') {
            await runCheckin();
        } else if (choice === '3') {
            await taskMenu();
        } else if (choice === '4') {
            await extractAccountInfo();
        } else {
            warn('无效选项，请输入 0、1、2、3 或 4。');
            continue;
        }
    }
    console.log(gray('\n  已退出。'));
    closeRl();
}

async function main() {
    if (typeof fetch !== 'function') {
        fail('当前 Node.js 版本过低，请安装 Node.js 18 或更高版本。');
        process.exit(1);
    }

    ensureDirs();
    const args = process.argv.slice(2);

    if (args.includes('--help') || args.includes('-h')) {
        banner('Trae CN 签到助手');
        console.log('  用法:');
        note('trae.cmd                        打开菜单');
        note('node src\\trae.js --login        添加账号');
        note('node src\\trae.js --checkin      立即签到（无菜单）');
        note('node src\\trae.js --help         显示本帮助');
        console.log('');
        return;
    }
    if (args.includes('--checkin')) {
        await runCheckin();
        if (args.includes('--pause')) {
            await waitAnyKey(gray('\n  按任意键关闭...'));
        }
        return;
    }
    if (args.includes('--login')) {
        await addAccounts();
        closeRl();
        return;
    }
    await menu();
}

main().catch(e => {
    fail(`运行出错: ${e.message}`);
    process.exitCode = 1;
});
