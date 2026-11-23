/*
 * Trae CN 登录/续期引擎（供 trae.js 调用）
 *
 * 用法:
 *   node auth-engine.js login   --file <账号json路径> --result <结果json路径> [--name <备注名>]
 *   node auth-engine.js refresh --file <账号json路径> --result <结果json路径>
 *
 * 设计要点:
 *   - 完全复刻官方客户端的 OAuth 流程: PKCE + 本地回环回调 + ExchangeToken
 *   - 设备身份(deviceId/machineId)与 EC P-256 密钥对由本脚本生成并保存在账号文件里
 *   - 绝不调用 ClearRefreshToken，因此 refreshToken 会一直有效（约 6 个月），可自动续期
 *   - 结果写入 --result 指定的文件，避免 PowerShell 读取子进程 stdout 的编码问题
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');

// ---------------- 固定配置（来自客户端 product.json） ----------------
const CONFIG = {
    consoleHost: 'https://www.trae.cn',
    apiHost: 'https://api.trae.cn',
    clientId: 'ono9krqynydwx5',   // iCubeApp.authConfig.TRAE.stable
    appVersion: '1.107.1',        // product.json version
    pluginVersion: '2.3.103559',  // product.json tronBuildVersion
    appType: 'stable'
};

const AUTH_KEY = 'iCubeAuthInfo://icube.cloudide';
const TOKEN_PATH = '/trae/api/v3/oauth/ExchangeToken';
const USERINFO_PATH = '/cloudide/api/v3/trae/GetUserInfo';

// 与客户端一致的固定混淆表
const URE = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37];
const DRE = [31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125];

// ---------------- 基础工具 ----------------
function fail(stage, code, message, detail) {
    const err = new Error(message);
    err.stage = stage;
    err.code = code;
    err.detail = detail;
    return err;
}

function sha512(buf) {
    return crypto.createHash('sha512').update(buf).digest();
}

function decryptAuth(b64) {
    const t = Buffer.from(b64, 'base64');
    const key = t.subarray(6, 38);
    const part1 = sha512(key);
    const xor = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) xor[i] = URE[i] ^ DRE[i];
    const h = sha512(Buffer.concat([part1, xor]));
    const d = crypto.createDecipheriv('aes-128-cbc', h.subarray(0, 16), h.subarray(16, 32));
    const plain = Buffer.concat([d.update(t.subarray(38)), d.final()]);
    return JSON.parse(plain.subarray(64).toString('utf8'));
}

function encryptAuth(obj) {
    const key = crypto.randomBytes(32);
    const part1 = sha512(key);
    const xor = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) xor[i] = URE[i] ^ DRE[i];
    const h = sha512(Buffer.concat([part1, xor]));
    const c = crypto.createCipheriv('aes-128-cbc', h.subarray(0, 16), h.subarray(16, 32));
    const plain = Buffer.concat([crypto.randomBytes(64), Buffer.from(JSON.stringify(obj), 'utf8')]);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([Buffer.alloc(6), key, ct]).toString('base64');
}

function randomHex(n) {
    return crypto.randomBytes(n).toString('hex');
}

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    return { publicKey, privateKey };
}

function buildProof(method, apiPath, clientId, secret, privateKeyPem) {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomHex(16);
    const payload = [method, apiPath, clientId, secret, String(timestamp), nonce].join('\n');
    const signature = crypto.sign('sha256', Buffer.from(payload, 'utf8'), privateKeyPem).toString('base64');
    return { Signature: signature, Timestamp: timestamp, Nonce: nonce };
}

function buildDeviceInfo(device, keys) {
    return {
        DeviceID: device.deviceId,
        MachineID: device.machineId,
        PlatformCode: 'IDE_PC',
        DeviceType: 'PC',
        DeviceName: 'Windows PC',
        DeviceModel: '',
        ClientVersion: CONFIG.appVersion,
        DevicePublicKey: keys.publicKey,
        DeviceBrand: '',
        DeviceCPU: (os.cpus()[0] && os.cpus()[0].model) || '',
        OSInfo: 'Windows',
        OSVersion: os.release()
    };
}

// 归一化时间字段：兼容 ISO 字符串、秒、毫秒
function normalizeTime(value, fallbackMs) {
    if (value === undefined || value === null || value === '') {
        return new Date(fallbackMs).toISOString();
    }
    if (typeof value === 'number') {
        return new Date(value < 1e12 ? value * 1000 : value).toISOString();
    }
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
    return new Date(fallbackMs).toISOString();
}

async function postJson(url, token, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-cloudide-token': token || ''
        },
        body: JSON.stringify(body)
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw fail('http', String(res.status), '服务端返回了非 JSON 内容', text.slice(0, 300));
    }
    return { status: res.status, json };
}

// ---------------- 换票 / 用户信息 ----------------
async function exchangeToken(secretType, secret, codeVerifier, device, keys, oldToken) {
    const proof = buildProof('POST', TOKEN_PATH, CONFIG.clientId, secret, keys.privateKey);
    const body = {
        ClientID: CONFIG.clientId,
        ClientSecret: '',
        DeviceInfo: buildDeviceInfo(device, keys),
        DeviceProof: proof,
        IDEVersion: CONFIG.appVersion
    };
    if (secretType === 'authCode') {
        body.AuthCode = secret;
        body.CodeVerifier = codeVerifier;
    } else {
        body.RefreshToken = secret;
    }

    let resp;
    try {
        resp = await postJson(CONFIG.apiHost + TOKEN_PATH, oldToken || '', body);
    } catch (e) {
        throw fail('exchange', 'NETWORK', '请求换票接口失败: ' + e.message);
    }

    const meta = resp.json.ResponseMetadata || {};
    const result = resp.json.Result;
    if (!result || !result.Token) {
        const code = (meta.Error && meta.Error.Code) || resp.json.code || resp.status;
        const message = (meta.Error && meta.Error.Message) || resp.json.message || '换票失败';
        throw fail('exchange', String(code), message, resp.json);
    }
    return result;
}

async function getUserInfo(token) {
    const resp = await postJson(CONFIG.apiHost + USERINFO_PATH, token, {
        ReqSource: 'IDE',
        IDEVersion: CONFIG.appVersion
    });
    if (!resp.json.Result) {
        throw fail('userinfo', String(resp.status), '获取用户信息失败', resp.json);
    }
    return resp.json.Result;
}

function buildAuthInfo(exchange, userInfo, apiHost) {
    const now = Date.now();
    const uid = userInfo.UserID || userInfo.user_id || userInfo.uid || '';
    const region = userInfo.Region || userInfo.region || (userInfo.UserRegion && userInfo.UserRegion.region) || 'CN';
    const aiRegion = userInfo.AiRegion || userInfo.ai_region || region;
    return {
        token: exchange.Token,
        refreshToken: exchange.RefreshToken || '',
        expiredAt: normalizeTime(exchange.ExpiredAt || exchange.TokenExpireAt || exchange.ExpireAt, now + 14 * 24 * 3600 * 1000),
        refreshExpiredAt: normalizeTime(exchange.RefreshExpiredAt || exchange.RefreshExpireAt, now + 180 * 24 * 3600 * 1000),
        tokenReleaseAt: new Date().toISOString(),
        userId: uid,
        host: apiHost,
        userRegion: { region, _aiRegion: aiRegion },
        account: {
            username: userInfo.ScreenName || userInfo.Username || userInfo.username || userInfo.Name || '',
            iss: userInfo.iss || '',
            iat: userInfo.iat || 0,
            organization: userInfo.organization || '',
            work_country: userInfo.work_country || '',
            email: userInfo.Email || userInfo.email || '',
            avatar_url: userInfo.avatar_url || userInfo.AvatarUrl || '',
            scope: 'TRAE',
            loginScope: 'TRAE',
            storeRegion: region,
            userTag: 'CN'
        }
    };
}

// ---------------- 文件读写 ----------------
function readAccountFile(file) {
    if (!fs.existsSync(file)) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function deviceFileFor(accountFile) {
    return accountFile.replace(/\.json$/i, '.device.json');
}

function loadDevice(accountFile) {
    const existing = readAccountFile(accountFile) || {};
    const extra = existing.traeSignCenter || {};
    // 账号文件不存在时，沿用同名的 .device.json，避免被服务端识别成新设备
    const deviceJson = readAccountFile(deviceFileFor(accountFile)) || {};
    const deviceId = extra.deviceId || deviceJson.device_id || randomHex(16);
    const machineId = extra.machineId || deviceJson.machine_id || randomHex(32);
    const keys = extra.privateKey
        ? { publicKey: extra.publicKey, privateKey: extra.privateKey }
        : generateKeyPair();
    return { deviceId, machineId, keys };
}

function saveAccount(accountFile, auth, device) {
    const storage = {
        'iCubeAuthInfo://icube.cloudide': encryptAuth(auth),
        'telemetry.machineId': device.machineId,
        'telemetry.devDeviceId': device.deviceId,
        traeSignCenter: {
            deviceId: device.deviceId,
            machineId: device.machineId,
            publicKey: device.keys.publicKey,
            privateKey: device.keys.privateKey,
            consoleHost: CONFIG.consoleHost,
            apiHost: CONFIG.apiHost,
            clientId: CONFIG.clientId,
            updatedAt: new Date().toISOString()
        }
    };
    writeJson(accountFile, storage);
    writeJson(deviceFileFor(accountFile), {
        device_id: device.deviceId,
        machine_id: device.machineId
    });
}

// ---------------- 登录流程 ----------------
function buildLoginUrl(port, device, challenge) {
    const callback = 'http://127.0.0.1:' + port + '/authorize';
    const extras = new URLSearchParams({
        x_device_id: device.deviceId,
        x_machine_id: device.machineId,
        x_device_brand: '',
        x_device_type: 'Windows',
        x_os_version: os.release(),
        x_app_version: CONFIG.appVersion,
        x_app_type: CONFIG.appType,
        code_challenge: challenge,
        code_challenge_method: 'S256'
    }).toString();
    return CONFIG.consoleHost + '/authorization'
        + '?login_version=1'
        + '&auth_from=trae'
        + '&login_channel=native_ide'
        + '&plugin_version=' + encodeURIComponent(CONFIG.pluginVersion)
        + '&auth_type=local'
        + '&client_id=' + encodeURIComponent(CONFIG.clientId)
        + '&redirect=0'
        + '&login_trace_id=' + crypto.randomUUID()
        + '&auth_callback_url=' + encodeURIComponent(callback)
        + '&machine_id=' + encodeURIComponent(device.machineId)
        + '&device_id=' + encodeURIComponent(device.deviceId)
        + '&' + extras;
}

function openBrowser(url) {
    // explorer.exe 会把 URL 当成路径，改用 start / url.dll 两种方式打开默认浏览器
    execFile('cmd.exe', ['/c', 'start', '', url], (err) => {
        if (!err) return;
        execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], () => { });
    });
}

function waitForCallback(server) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            server.close();
            reject(fail('login', 'TIMEOUT', '等待浏览器授权超时（5 分钟）'));
        }, 5 * 60 * 1000);

        server.on('request', (req, res) => {
            const reqUrl = req.url || '';
            if (req.method === 'OPTIONS') {
                res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'x-jwt-token' });
                res.end();
                return;
            }
            if (!reqUrl.startsWith('/authorize')) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h2>Trae 登录助手</h2><p>请回到登录页面完成授权。</p>');
                return;
            }

            const rawQuery = reqUrl.split('?')[1] || '';
            let params;
            try {
                params = new URLSearchParams(decodeURIComponent(rawQuery));
            } catch (e) {
                params = new URLSearchParams(rawQuery);
            }
            // 客户端会先整体解码再解析；若没拿到关键字段，再用原始串兜底
            if (!params.get('authCodeInfo') && !params.get('AuthCode') && !params.get('auth_code')) {
                params = new URLSearchParams(rawQuery);
            }
            console.error('收到授权回调');

            let authCode = '';
            const codeInfoRaw = params.get('authCodeInfo');
            if (codeInfoRaw) {
                try {
                    const info = JSON.parse(codeInfoRaw);
                    authCode = info.AuthCode || info.authCode || '';
                } catch (e) {
                    console.error('authCodeInfo 解析失败: ' + e.message);
                }
            }
            if (!authCode) authCode = params.get('AuthCode') || params.get('auth_code') || '';
            if (!authCode && !params.get('error_code')) {
                // 结构不认识时，把原始参数写进结果，便于一次性排查
                const unknown = fail('login', 'CALLBACK_FORMAT', '回调参数中没有找到 AuthCode', {
                    raw: decodeURIComponent(rawQuery).slice(0, 1500)
                });
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h2>授权回调格式无法识别</h2><p>请查看控制台输出的原始参数。</p>');
                clearTimeout(timer);
                server.close();
                reject(unknown);
                return;
            }
            if (params.get('error_code')) {
                const err = fail('login', String(params.get('error_code')), params.get('error_msg') || '授权被拒绝');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h2>授权失败</h2><p>' + (params.get('error_msg') || params.get('error_code')) + '</p>');
                clearTimeout(timer);
                server.close();
                reject(err);
                return;
            }

            let callbackUserInfo = null;
            try {
                const ui = params.get('userInfo');
                if (ui) callbackUserInfo = JSON.parse(ui);
            } catch (e) { /* 忽略，后面会用 GetUserInfo 兜底 */ }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2>登录成功</h2><p>可以关闭此页面，回到命令行查看结果。</p>');
            clearTimeout(timer);
            server.close();
            resolve({ authCode, userInfo: callbackUserInfo });
        });

        server.on('error', (e) => {
            clearTimeout(timer);
            reject(fail('login', 'SERVER', '本地回调服务启动失败: ' + e.message));
        });
    });
}

async function doLogin(options) {
    const device = loadDevice(options.file);
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    const server = http.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    const loginUrl = buildLoginUrl(port, device, challenge);
    console.error('即将打开浏览器授权页，请完成登录...');
    openBrowser(loginUrl);

    const callback = await waitForCallback(server);
    const exchange = await exchangeToken('authCode', callback.authCode, verifier, device, device.keys, '');

    // 统一以 GetUserInfo 为准，回调里的 userInfo 字段不完整时也能拿到账号信息
    const userInfo = await getUserInfo(exchange.Token);

    const auth = buildAuthInfo(exchange, userInfo, CONFIG.apiHost);
    saveAccount(options.file, auth, device);

    return {
        ok: true,
        action: 'login',
        file: options.file,
        name: options.name || path.basename(options.file, '.json'),
        uid: auth.userId,
        username: auth.account.username,
        email: auth.account.email,
        expiredAt: auth.expiredAt,
        refreshExpiredAt: auth.refreshExpiredAt,
        deviceId: device.deviceId,
        machineId: device.machineId
    };
}

// ---------------- 续期流程 ----------------
async function doRefresh(options) {
    const storage = readAccountFile(options.file);
    if (!storage) throw fail('refresh', 'FILE', '账号文件不存在或不是合法 JSON: ' + options.file);
    const enc = storage[AUTH_KEY];
    if (!enc) throw fail('refresh', 'NO_AUTH', '账号文件中没有登录态');
    const extra = storage.traeSignCenter;
    if (!extra || !extra.privateKey) {
        throw fail('refresh', 'NO_DEVICE_KEY', '账号文件缺少设备密钥，请通过 trae.js 菜单重新登录');
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(String(enc))) {
        // 防止把控制台输出等调试产物当成账号文件
        throw fail('refresh', 'BAD_FILE', '登录态字段格式异常');
    }

    const auth = decryptAuth(enc);
    if (!auth.refreshToken) throw fail('refresh', 'NO_REFRESH', '账号文件缺少 refreshToken，请重新登录');

    const device = {
        deviceId: extra.deviceId,
        machineId: extra.machineId,
        keys: { publicKey: extra.publicKey, privateKey: extra.privateKey }
    };

    let exchange;
    try {
        exchange = await exchangeToken('refreshToken', auth.refreshToken, '', device, device.keys, auth.token);
    } catch (e) {
        const code = String(e.code || '');
        if (code === '20101' || code === '20324' || code === '20315' || code === '20125') {
            throw fail('refresh', code, '登录会话已失效，请通过 trae.js 菜单重新登录');
        }
        throw e;
    }

    auth.token = exchange.Token;
    if (exchange.RefreshToken) auth.refreshToken = exchange.RefreshToken;
    auth.expiredAt = normalizeTime(exchange.ExpiredAt || exchange.TokenExpireAt || exchange.ExpireAt, Date.now() + 14 * 24 * 3600 * 1000);
    if (exchange.RefreshExpiredAt || exchange.RefreshExpireAt) {
        auth.refreshExpiredAt = normalizeTime(exchange.RefreshExpiredAt || exchange.RefreshExpireAt, Date.now() + 180 * 24 * 3600 * 1000);
    }
    auth.tokenReleaseAt = new Date().toISOString();
    auth.host = CONFIG.apiHost;

    storage[AUTH_KEY] = encryptAuth(auth);
    storage.traeSignCenter = Object.assign({}, extra, { updatedAt: new Date().toISOString() });
    writeJson(options.file, storage);

    return {
        ok: true,
        action: 'refresh',
        file: options.file,
        name: options.name || path.basename(options.file, '.json'),
        expiredAt: auth.expiredAt
    };
}

// ---------------- CLI ----------------
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
            out[key] = value;
        } else {
            out._.push(a);
        }
    }
    return out;
}

function writeResult(file, data) {
    if (file) writeJson(file, data);
}

// ---------------- 诊断：查看接口返回的用户信息字段 ----------------
async function doWhoami(options) {
    const storage = readAccountFile(options.file);
    if (!storage) throw fail('whoami', 'FILE', '账号文件不存在或不是合法 JSON: ' + options.file);
    const enc = storage[AUTH_KEY];
    if (!enc) throw fail('whoami', 'NO_AUTH', '账号文件中没有登录态');
    const auth = decryptAuth(enc);
    const userInfo = await getUserInfo(auth.token);
    return { ok: true, action: 'whoami', userInfo };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const action = args._[0];
    const resultFile = args.result;

    // --quiet: 不输出进度到 stderr，避免 PowerShell 把 UTF-8 当 ANSI 解码成乱码
    if (args.quiet !== undefined) {
        console.error = () => { };
    }

    if (!action || !args.file) {
        console.error('用法: node auth-engine.js <login|refresh|whoami> --file <账号json> --result <结果json>');
        process.exit(2);
    }

    try {
        let result;
        if (action === 'login') result = await doLogin(args);
        else if (action === 'whoami') result = await doWhoami(args);
        else result = await doRefresh(args);
        writeResult(resultFile, result);
        console.error('完成: ' + action);
        process.exit(0);
    } catch (e) {
        const payload = {
            ok: false,
            action,
            stage: e.stage || 'unknown',
            code: e.code !== undefined ? String(e.code) : '',
            message: e.message || '未知错误',
            detail: e.detail || null
        };
        writeResult(resultFile, payload);
        console.error('失败[' + payload.stage + '/' + payload.code + ']: ' + payload.message);
        process.exit(1);
    }
}

module.exports = {
    CONFIG,
    AUTH_KEY,
    doLogin,
    doRefresh,
    doWhoami,
    decryptAuth,
    readAccountFile
};

if (require.main === module) {
    main();
}
