import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectTrustedCli } from "../scripts/trusted-cli-inspection.mjs";
import { isReadOnlyRemoteProbe } from "../scripts/ssh-inspection.mjs";
import { inspectionWords } from "../scripts/inspection-command.mjs";

const prefix = ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "instory@instoryMacmini.local"];
const root = "/Users/instory/Services/instory-lan";
const git = `git --no-optional-locks -c core.fsmonitor=false -C ${root}/src/instory`;

test("远端资源、账户和 HTTPS 探针只接受有界精确投影", () => {
  const curl = `/usr/bin/env -i /usr/bin/curl -q --noproxy '*' --proto '=https' --connect-timeout 5 --max-time 15 --silent --show-error --output /dev/null --write-out 'http_code=%{http_code} remote_ip=%{remote_ip} ssl_verify_result=%{ssl_verify_result} time_namelookup=%{time_namelookup} time_connect=%{time_connect} time_appconnect=%{time_appconnect} time_total=%{time_total}\\n' https://git.myinstory.com/`;
  const check = command => isReadOnlyRemoteProbe(inspectionWords(command) || []);
  for (const command of ["/usr/sbin/sysctl hw.model hw.ncpu hw.memsize", "/usr/sbin/sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level",
    "/usr/bin/vm_stat", "/usr/bin/dscl . -list /Users UniqueID", "/usr/bin/dscl . -read /Users/instory UniqueID NFSHomeDirectory UserShell", curl]) assert.equal(check(command), true, command);
  for (const command of ["sysctl hw.memsize", "/usr/bin/sysctl hw.memsize", "/tmp/sysctl hw.memsize", "/usr/sbin/sysctl", "/usr/sbin/sysctl -a",
    "/usr/sbin/sysctl -w hw.ncpu=1", "/usr/sbin/sysctl hw.ncpu=1", "/usr/sbin/sysctl kern.hostname", "/usr/sbin/sysctl -n",
    "vm_stat", "/usr/bin/vm_stat 1", "/usr/bin/vm_stat -c 1", "/usr/bin/dscl . -list /Users", "/usr/bin/dscl /LDAPv3/server -list /Users UniqueID",
    "/usr/bin/dscl . -read /Users/instory", "/usr/bin/dscl . -read /Users/instory Password", "/usr/bin/dscl . -read /Users/instory ShadowHashData",
    "/usr/bin/dscl . -read /Users/../root UniqueID", "/usr/bin/dscl . -create /Users/runner UniqueID 502", "/usr/bin/dscl . -authonly instory secret",
    curl.replace("/usr/bin/env -i ", ""), curl.replace("env -i", "env SSLKEYLOGFILE=/tmp/key"), curl.replace("/usr/bin/curl", "curl"),
    curl.replace(" -q ", " "), curl.replace("--output /dev/null", "--output /tmp/body"), curl.replace("--output /dev/null", "--include"),
    curl.replace("--write-out", "--insecure --write-out"), curl.replace("--write-out", "--location --write-out"),
    curl.replace("%{http_code}", "%{header_json}"), curl.replace("%{http_code}", "%output{/tmp/x}"),
    curl.replace("git.myinstory.com", "evil.example"), curl.replace("https://", "http://"), curl.replace("https://", "https://user:pass@"),
    `${curl} --netrc`, `${curl} -X POST`, `${curl} --upload-file /tmp/x`, `${curl} --proxy http://evil`, `${curl} --cookie /tmp/cookies`]) assert.equal(check(command), false, command);
});
test("SSH 只放行固定主机与精确远端只读检查", () => {
  const check = command => inspectTrustedCli([...prefix, command], {});
  for (const command of ["hostname", "uptime", "/bin/hostname", "ps -axo pid,ppid,comm", "pgrep -x instory", "pgrep -x instory-admin",
    `ls -la ${root}/launch`, `ls -ld ${root} ${root}/releases/`, `${git} status --short`, `${git} rev-parse HEAD`,
    `${git.replace("src/instory", "src/instory-admin")} rev-parse HEAD`,
    "docker ps --format={{.Names}}", "docker ps -a --format={{.Status}}", "/usr/local/bin/docker ps --format={{.Ports}}",
    "curl -q --max-time 10 http://127.0.0.1:8500/readyz", "curl -q --max-time 10 http://127.0.0.1:8501/healthz"]) assert.equal(check(command), true, command);
  for (const command of ["hostname x", "hostname; touch /tmp/x", "hostname && reboot", "hostname | sh", "hostname $(touch /tmp/x)", "hostname `id`",
    "hostname\nreboot", "hostname > /tmp/x", "sh -c hostname", "env hostname", "sudo hostname", "cat /Users/instory/.ssh/id_ed25519",
    `ls -la ${root}/../.ssh`, "ls -la /", "ls -R /", `cat ${root}/launch/run-core.sh`,
    `git -C ${root}/src/instory status --short`, `${git} reset --hard`, `${git} config --list`, `${git} show HEAD`, `${git} rev-parse --git-path config`,
    `${git.replace("core.fsmonitor=false", "core.fsmonitor=/tmp/evil")} status --short`,
    "ps eww", "ps -axo pid,ppid,args", "docker inspect app", "docker ps", "docker exec app sh", "docker ps --format={{.Command}}", "docker ps --format={{.Names}}; touch /tmp/x",
    "curl http://127.0.0.1:8500/readyz", "curl -q --max-time 10 http://evil/healthz", "curl -q --max-time 10 http://127.0.0.1:8500/admin/delete",
    "curl -q --max-time 10 http://127.0.0.1:8500/readyz -X POST", "curl -q --max-time 10 http://127.0.0.1:8500/readyz -o /tmp/x"]) assert.equal(check(command), false, command);
  for (const entry of ["ssh", "/usr/bin/ssh"]) {
    assert.equal(inspectTrustedCli([entry, "-V"], {}), true);
    assert.equal(inspectTrustedCli(["rtk", "proxy", entry, ...prefix.slice(1), "hostname"], {}), true);
  }
  for (const words of [["/tmp/ssh", ...prefix.slice(1), "hostname"], ["/tmp/rtk", "proxy", ...prefix, "hostname"], ["rtk", ...prefix, "hostname"],
    ["env", "SSH_ASKPASS=/tmp/x", ...prefix, "hostname"], [...prefix.slice(0, -1), "root@instoryMacmini.local", "hostname"],
    [...prefix.slice(0, -1), "instory@evil", "hostname"], [...prefix, "-o", "ProxyCommand=evil", "hostname"],
    ["ssh", "-o", "ProxyCommand=evil", ...prefix.slice(1), "hostname"], ["ssh", "-F", "/tmp/config", ...prefix.slice(1), "hostname"],
    ["ssh", "-L", "8000:evil:80", ...prefix.slice(1), "hostname"], ["ssh", "-t", ...prefix.slice(1), "hostname"],
    ["ssh", "-o", "BatchMode=yes", "instory@instoryMacmini.local", "hostname"], [...prefix], ["ssh", "-V", "--debug"]]) assert.notEqual(inspectTrustedCli(words, {}), true, words.join(" "));
  assert.equal(inspectTrustedCli([...prefix.slice(0, -1), "-n", "-T", "-o", "StrictHostKeyChecking=yes", prefix.at(-1), "hostname"], {}), true);
  assert.equal(inspectTrustedCli([...prefix, "git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", `${root}/src/instory`, "status", "--short"], {}), true);
});

test("SSH 拒绝 PATH 中伪造的同名入口", t => {
  const dir = mkdtempSync(join(tmpdir(), "ssh-identity-")), path = process.env.PATH;
  t.after(() => { process.env.PATH = path; rmSync(dir, { recursive: true, force: true }); });
  writeFileSync(join(dir, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = `${dir}:${path}`;
  assert.equal(inspectTrustedCli(["ssh", ...prefix.slice(1), "hostname"], {}), false);
  assert.equal(inspectTrustedCli([...prefix, "hostname"], {}), true);
});
