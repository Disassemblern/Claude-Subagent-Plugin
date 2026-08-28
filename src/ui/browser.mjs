import { createServer } from "node:http";
import { spawn } from "node:child_process";

export const name = "browser";

// Works anywhere there is a browser, which is the point: it is what makes this
// installable by people who are not on Windows.
export const available = () => true;

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

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

function page(rows) {
  const cards = rows
    .map((r) => {
      const options = MODELS.map(
        (m) => `<option value="${m}"${m === r.effectiveModel ? " selected" : ""}>${m}</option>`,
      ).join("");
      return `<div class="row" data-id="${esc(r.toolUseId)}">
  <label class="run"><input type="checkbox" class="approve" checked> <span class="desc">${esc(r.description) || "(no description)"}</span></label>
  <div class="type">${esc(r.subagentType) || "(default)"}</div>
  <div class="prompt">${esc(r.prompt)}</div>
  <div class="controls">
    <label>model <select class="model">${options}</select></label>
    <label class="remember"><input type="checkbox" class="rem"> remember for this type</label>
  </div>
</div>`;
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Subagent gate</title>
<style>
:root{--bg:#f5f8f7;--card:#fff;--line:#d3dedc;--ink:#0f1f1e;--dim:#657876;--accent:#0b6e6b}
@media(prefers-color-scheme:dark){:root{--bg:#0b1716;--card:#11201f;--line:#2b403e;--ink:#e8f0ef;--dim:#7e9291;--accent:#4fbdb4}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
main{max-width:820px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
p.lede{color:var(--dim);margin:0 0 20px}
.row{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:14px 16px;margin-bottom:10px}
.run{display:flex;gap:8px;align-items:center;font-weight:600}
.type{font:12px ui-monospace,monospace;color:var(--accent);margin:4px 0 0 24px}
.prompt{color:var(--dim);font-size:13px;margin:6px 0 10px 24px;white-space:pre-wrap;max-height:70px;overflow:auto}
.controls{display:flex;gap:18px;align-items:center;margin-left:24px;flex-wrap:wrap}
select{padding:4px 8px;border-radius:4px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.remember{font-size:13px;color:var(--dim);display:flex;gap:6px;align-items:center}
.actions{display:flex;gap:10px;margin-top:18px}
button{padding:9px 18px;border-radius:5px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:14px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.done{text-align:center;padding:60px 0;color:var(--dim)}
</style></head><body><main>
<h1>${rows.length} subagent${rows.length === 1 ? "" : "s"} about to spawn</h1>
<p class="lede">Uncheck to block one. Change the model to control what it costs.</p>
<div id="rows">${cards}</div>
<div class="actions">
  <button class="primary" id="approve">Approve</button>
  <button id="cancel">Cancel all</button>
</div>
</main>
<script>
function collect(approvedAll){
  const out={};
  document.querySelectorAll('.row').forEach(function(row){
    const model=row.querySelector('.model').value;
    out[row.dataset.id]={
      approved: approvedAll && row.querySelector('.approve').checked,
      model: model==='inherit'?null:model,
      remember: row.querySelector('.rem').checked
    };
  });
  return out;
}
function send(approvedAll){
  fetch('/decide',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({result:approvedAll?'approve':'cancel',decisions:collect(approvedAll)})})
    .then(function(){document.body.innerHTML='<div class="done">Sent. You can close this tab.</div>';});
}
document.getElementById('approve').onclick=function(){send(true)};
document.getElementById('cancel').onclick=function(){send(false)};
</script></body></html>`;
}

export function ask(rows, { timeoutMs, onUrl }, env = process.env) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch { /* already closing */ }
      fn(value);
    };

    const server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/decide") {
        let body = "";
        req.on("data", (c) => { body += c; });
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
      res.end(page(rows));
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
