import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

export const name = "browser";

// Works anywhere there is a browser, which is the point: it is what makes this
// installable by people who are not on Windows.
export const available = () => true;

const MODELS = ["inherit", "haiku", "sonnet", "opus", "fable"];

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // If the browser cannot be opened the request simply times out, which the
    // caller already treats as allow-unchanged.
  }
}

// Rows are fetched by the page rather than baked into it: spawns from one turn
// arrive over many seconds, so the window opens at once and fills in.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<title>Subagent gate</title>
<style>
:root{--bg:#f5f8f7;--card:#fff;--line:#d3dedc;--ink:#0f1f1e;--dim:#657876;--accent:#0b6e6b;--warn:#9a5410;--ok:#1c6b3f}
@media(prefers-color-scheme:dark){:root{--bg:#0b1716;--card:#11201f;--line:#2b403e;--ink:#e8f0ef;--dim:#7e9291;--accent:#4fbdb4;--warn:#d9a05c;--ok:#6fc292}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
main{max-width:820px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
p.lede{color:var(--dim);margin:0 0 6px}
p.status{color:var(--warn);margin:0 0 18px;font-size:13.5px;min-height:20px}
.row{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin-bottom:10px}
.run{display:flex;gap:8px;align-items:center;font-weight:600}
.type{font:12px ui-monospace,monospace;color:var(--accent);margin:4px 0 0 24px}
.prompt{color:var(--dim);font-size:13px;margin:6px 0 10px 24px;white-space:pre-wrap;max-height:70px;overflow:auto}
.controls{display:flex;gap:18px;align-items:center;margin-left:24px;flex-wrap:wrap}
select{padding:4px 8px;border-radius:4px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.rem{font-size:13px;color:var(--dim);display:flex;gap:6px;align-items:center}
.actions{display:flex;gap:10px;margin-top:18px}
button{padding:9px 18px;border-radius:5px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:14px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.done{text-align:center;padding:60px 0;color:var(--dim)}
</style></head><body><main>
<h1 id="title">Waiting for subagents...</h1>
<p class="lede">Uncheck to block a spawn. Change the model to control what it costs.</p>
<p class="status" id="status"></p>
<div id="rows"></div>
<div class="actions">
  <button class="primary" id="approve">Approve</button>
  <button id="cancel">Cancel all</button>
</div>
</main>
<script>
var MODELS = __MODELS__;
var seen = {};
var final = false;

function esc(s){ var d=document.createElement('div'); d.textContent=s==null?'':String(s); return d.innerHTML; }

function addRow(r){
  if (seen[r.toolUseId]) return;
  seen[r.toolUseId] = true;
  var opts = MODELS.map(function(m){
    return '<option value="'+m+'"'+(m===r.effectiveModel?' selected':'')+'>'+m+'</option>';
  }).join('');
  var el = document.createElement('div');
  el.className = 'row';
  el.dataset.id = r.toolUseId;
  el.innerHTML =
    '<label class="run"><input type="checkbox" class="approve" checked> <span>'+(esc(r.description)||'(no description)')+'</span></label>'+
    '<div class="type">'+(esc(r.subagentType)||'(default)')+'</div>'+
    '<div class="prompt">'+esc(r.prompt)+'</div>'+
    '<div class="controls"><label>model <select class="model">'+opts+'</select></label>'+
    '<label class="rem"><input type="checkbox" class="remcb"> remember for this type</label></div>';
  document.getElementById('rows').appendChild(el);
}

function refresh(){
  fetch('/rows').then(function(r){ return r.json(); }).then(function(doc){
    (doc.rows||[]).forEach(addRow);
    var n = Object.keys(seen).length;
    document.getElementById('title').textContent = n + ' subagent' + (n===1?'':'s');
    final = !!doc.final;
    var status = document.getElementById('status');
    var approve = document.getElementById('approve');
    // The runtime reports each spawn only as it happens, so there is no total to
    // show. Say whether more may still arrive, and when we stop waiting.
    if (final) {
      status.style.color = 'var(--ok)';
      status.textContent = 'All ' + n + ' spawn' + (n===1?'':'s') + ' received - nothing more is coming.';
      approve.textContent = 'Approve';
    } else {
      var left = Math.max(0, Math.ceil(((doc.settleAt || 0) - Date.now()) / 1000));
      status.style.color = 'var(--warn)';
      status.textContent = 'Still receiving spawns - ' + n + ' so far, waiting ' + left +
        ' more second(s) for others. Approving now applies only to these ' + n + '.';
      approve.textContent = 'Approve these ' + n;
      setTimeout(refresh, 300);
    }
  }).catch(function(){ if (!final) setTimeout(refresh, 800); });
}

function collect(approvedAll){
  var out = {};
  document.querySelectorAll('.row').forEach(function(row){
    var model = row.querySelector('.model').value;
    out[row.dataset.id] = {
      approved: approvedAll && row.querySelector('.approve').checked,
      model: model === 'inherit' ? null : model,
      remember: row.querySelector('.remcb').checked
    };
  });
  return out;
}

function send(approvedAll){
  fetch('/decide', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({result: approvedAll?'approve':'cancel', decisions: collect(approvedAll)})})
    .then(function(){ document.body.innerHTML = '<div class="done">Sent. You can close this tab.</div>'; });
}

document.getElementById('approve').onclick = function(){ send(true); };
document.getElementById('cancel').onclick = function(){ send(false); };
refresh();
</script></body></html>`;

export function ask(rows, { timeoutMs, rowsFile, onUrl }, env = process.env) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        // Already closing.
      }
      fn(value);
    };

    const currentRows = () => {
      if (!rowsFile) return { rows, final: true };
      try {
        return JSON.parse(readFileSync(rowsFile, "utf8"));
      } catch {
        return { rows, final: false }; // Mid-write; the page retries.
      }
    };

    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/rows") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(currentRows()));
        return;
      }
      if (req.method === "POST" && req.url === "/decide") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
          try {
            finish(resolve, JSON.parse(body));
          } catch (err) {
            finish(reject, new Error(`bad decision payload: ${err.message}`));
          }
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE.replace("__MODELS__", JSON.stringify(MODELS)));
    });

    const timer = setTimeout(() => finish(reject, new Error("browser gate timed out")), timeoutMs);

    server.on("error", (err) => finish(reject, err));
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}/`;
      if (typeof onUrl === "function") onUrl(url);
      if (env.SUBAGENT_GATE_NO_OPEN !== "1") openBrowser(url);
    });
  });
}
