/**
 * MVA Hackathon 2026 · Track 2 討論板後端
 *
 * 綁定到試算表後部署為 Web App：
 *   執行身分：我
 *   存取權：任何人
 *
 * 試算表：https://docs.google.com/spreadsheets/d/1lBt_9ARLPNZUOkS68ApBpddYzTcLCKJaHxh8Duc45dU/edit
 */

var TEAM_TOKEN = 'mva-track2-2026';
var POSTS_SHEET = 'posts';
var META_SHEET = 'meta';
var MAX_CONTENT = 8000;
var HEADERS = ['id', 'parent_id', 'author', 'role', 'content', 'created_at', 'ask_ai', 'ai_status'];

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    if (p.payload) {
      var parsed = JSON.parse(p.payload);
      return handleWrite_(parsed);
    }
    return handleRead_(p);
  } catch (err) {
    return json_( { ok: false, error: String(err) }, e && e.parameter && e.parameter.callback );
  }
}

function doPost(e) {
  try {
    var data = {};
    if (e && e.postData && e.postData.contents) {
      var raw = e.postData.contents;
      try {
        data = JSON.parse(raw);
      } catch (ignore) {
        data = e.parameter || {};
        if (data.payload) data = JSON.parse(data.payload);
      }
    } else if (e && e.parameter) {
      data = e.parameter.payload ? JSON.parse(e.parameter.payload) : e.parameter;
    }
    return handleWrite_(data);
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function handleRead_(p) {
  var action = p.action || 'list';
  ensureSheets_();
  if (action === 'list' || action === 'pending_ai' || action === 'status') {
    var messages = readPosts_();
    if (action === 'pending_ai') {
      messages = messages.filter(function (m) {
        return String(m.ask_ai).toLowerCase() === 'true' && m.ai_status === 'pending';
      });
    }
    return json_({
      ok: true,
      messages: messages,
      heartbeat: readMeta_('heartbeat'),
      model: readMeta_('model'),
      workerStatus: readMeta_('worker_status')
    }, p.callback);
  }
  if (action === 'ping') {
    return json_({ ok: true, now: nowIso_() }, p.callback);
  }
  return json_({ ok: false, error: 'unknown action' }, p.callback);
}

function handleWrite_(data) {
  data = data || {};
  if (data.token !== TEAM_TOKEN) {
    return json_({ ok: false, error: 'invalid token' });
  }
  ensureSheets_();
  var action = data.action || 'create';
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (action === 'create' || action === 'reply') {
      return json_(appendPost_(data));
    }
    if (action === 'request_ai') {
      return json_(requestAi_(data.id));
    }
    if (action === 'mark_ai') {
      return json_(markAi_(data.id, data.ai_status || 'done'));
    }
    if (action === 'heartbeat') {
      writeMeta_('heartbeat', nowIso_());
      writeMeta_('model', String(data.model || ''));
      writeMeta_('worker_status', String(data.status || 'online'));
      return json_({ ok: true });
    }
    return json_({ ok: false, error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}

function appendPost_(data) {
  var sheet = postsSheet_();
  var id = Utilities.getUuid();
  var parentId = String(data.parent_id || '');
  var author = clean_(data.author, 80) || '匿名';
  var role = data.role === 'ai' ? 'ai' : 'human';
  var content = clean_(data.content, MAX_CONTENT);
  if (!content) return { ok: false, error: 'content required' };
  var askAi = !!data.ask_ai;
  var aiStatus = askAi ? 'pending' : 'none';
  var created = nowIso_();
  sheet.appendRow([id, parentId, author, role, content, created, askAi ? 'TRUE' : 'FALSE', aiStatus]);
  return {
    ok: true,
    message: {
      id: id,
      parent_id: parentId,
      author: author,
      role: role,
      content: content,
      created_at: created,
      ask_ai: askAi,
      ai_status: aiStatus
    }
  };
}

function requestAi_(id) {
  var loc = findRow_(id);
  if (!loc) return { ok: false, error: 'not found' };
  loc.sheet.getRange(loc.row, 7, 1, 2).setValues([['TRUE', 'pending']]);
  return { ok: true, id: id, ai_status: 'pending' };
}

function markAi_(id, status) {
  var loc = findRow_(id);
  if (!loc) return { ok: false, error: 'not found' };
  loc.sheet.getRange(loc.row, 8).setValue(status);
  if (status === 'done') loc.sheet.getRange(loc.row, 7).setValue('TRUE');
  return { ok: true, id: id, ai_status: status };
}

function readPosts_() {
  var sheet = postsSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (!row[0]) continue;
    out.push({
      id: String(row[0]),
      parent_id: String(row[1] || ''),
      author: String(row[2] || ''),
      role: String(row[3] || 'human'),
      content: String(row[4] || ''),
      created_at: String(row[5] || ''),
      ask_ai: String(row[6]).toUpperCase() === 'TRUE' || row[6] === true,
      ai_status: String(row[7] || 'none')
    });
  }
  return out;
}

function findRow_(id) {
  var sheet = postsSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return { sheet: sheet, row: i + 2 };
  }
  return null;
}

function ensureSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var posts = ss.getSheetByName(POSTS_SHEET);
  if (!posts) {
    posts = ss.insertSheet(POSTS_SHEET);
  }
  var header = posts.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  if (String(header[0]) !== 'id') {
    posts.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    posts.setFrozenRows(1);
  }
  var meta = ss.getSheetByName(META_SHEET);
  if (!meta) {
    meta = ss.insertSheet(META_SHEET);
    meta.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
    meta.setFrozenRows(1);
  }
}

function postsSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(POSTS_SHEET);
}

function metaSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(META_SHEET);
}

function readMeta_(key) {
  var sheet = metaSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return '';
  var values = sheet.getRange(2, 1, last - 1, 2).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === key) return String(values[i][1] || '');
  }
  return '';
}

function writeMeta_(key, value) {
  var sheet = metaSheet_();
  var last = sheet.getLastRow();
  if (last >= 2) {
    var values = sheet.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]) === key) {
        sheet.getRange(i + 2, 2).setValue(value);
        return;
      }
    }
  }
  sheet.appendRow([key, value]);
}

function clean_(text, max) {
  return String(text || '').replace(/^\s+|\s+$/g, '').substring(0, max);
}

function nowIso_() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function json_(obj, callback) {
  var text = JSON.stringify(obj);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + text + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(text)
    .setMimeType(ContentService.MimeType.JSON);
}
