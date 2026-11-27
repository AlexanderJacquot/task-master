//! What the machine is like when a transcription starts, for `scribe.log`: the CPU, and
//! whether it runs on battery and in which power mode (Windows slows background apps
//! down on battery or in "best power efficiency"). Read with the OS's own tools, so no
//! system calls here.

#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::time::Duration;

/// How long the OS tools get before the line says so instead.
#[cfg(any(target_os = "windows", target_os = "macos"))]
const WAIT: Duration = Duration::from_secs(15);

/// PowerShell prints one `key=value` per line; read by [`windows_summary`].
#[cfg(target_os = "windows")]
const WINDOWS_QUERY: &str = r"[Console]::OutputEncoding = [Text.Encoding]::UTF8
$p = Get-CimInstance Win32_Processor | Select-Object -First 1
$b = Get-CimInstance Win32_Battery | Select-Object -First 1
$o = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes' -ErrorAction SilentlyContinue
'cpu=' + $p.Name
'cores=' + $p.NumberOfCores
'threads=' + $p.NumberOfLogicalProcessors
'battery=' + $b.BatteryStatus
'overlay_ac=' + $o.ActiveOverlayAcPowerScheme
'overlay_dc=' + $o.ActiveOverlayDcPowerScheme
'plan=' + ((powercfg /getactivescheme) -join ' ')";

/// One line: the CPU and the power state. Takes a second or two (it starts PowerShell).
#[cfg(target_os = "windows")]
pub fn describe() -> String {
    match run(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY],
    ) {
        Ok(out) => windows_summary(&out),
        Err(e) => format!("not read ({e})"),
    }
}

#[cfg(target_os = "macos")]
pub fn describe() -> String {
    let cpu = run(
        "sysctl",
        &[
            "-n",
            "machdep.cpu.brand_string",
            "hw.physicalcpu",
            "hw.logicalcpu",
        ],
    );
    let power = run("pmset", &["-g", "batt"]);
    match (cpu, power) {
        (Ok(cpu), Ok(power)) => mac_summary(&cpu, &power),
        (Err(e), _) | (_, Err(e)) => format!("not read ({e})"),
    }
}

/// Scribe does not transcribe on Linux.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn describe() -> String {
    String::new()
}

/// A tool's output, or why there is none. Gives up after [`WAIT`] (the tool may go on).
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = std::process::Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing up.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = send.send(command.output());
    });
    match receive.recv_timeout(WAIT) {
        Ok(Ok(out)) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).into()),
        Ok(Ok(out)) => Err(format!("{program} exited with {}", out.status)),
        Ok(Err(e)) => Err(format!("cannot run {program}: {e}")),
        Err(_) => Err(format!("{program} took over {} s", WAIT.as_secs())),
    }
}

/// `CPU …(cores, threads); on battery|plugged in; power mode …; power plan …`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn windows_summary(output: &str) -> String {
    let get = |key: &str| {
        output
            .lines()
            .find_map(|l| l.trim().strip_prefix(key)?.strip_prefix('='))
            .map(str::trim)
            .filter(|v| !v.is_empty())
    };
    let mut parts = vec![cpu_part(
        get("cpu"),
        get("cores").and_then(|v| v.parse().ok()),
        get("threads").and_then(|v| v.parse().ok()),
    )];
    // Win32_Battery.BatteryStatus: 1 discharging, 4 low, 5 critical: on battery; 2 means
    // "on AC", 3 fully charged, 6 to 9 charging. No battery at all: a desktop.
    let on_battery = match get("battery") {
        None => {
            parts.push("no battery".into());
            false
        }
        Some("1" | "4" | "5") => {
            parts.push("on battery".into());
            true
        }
        Some("2" | "3" | "6" | "7" | "8" | "9") => {
            parts.push("plugged in".into());
            false
        }
        Some(other) => {
            parts.push(format!("battery status {other}"));
            false
        }
    };
    // Windows 11's power mode slider (Settings → System → Power), per power source.
    let overlay = if on_battery {
        get("overlay_dc")
    } else {
        get("overlay_ac")
    };
    if let Some(guid) = overlay {
        let mode = match guid.to_ascii_lowercase().as_str() {
            "961cc777-2547-4f9d-8174-7d86181b8a7a" => "best power efficiency".to_owned(),
            "00000000-0000-0000-0000-000000000000" => "balanced".to_owned(),
            "ded574b5-45a0-4f42-8737-46345c09c238" => "best performance".to_owned(),
            other => other.to_owned(),
        };
        parts.push(format!("power mode {mode}"));
    }
    // `powercfg /getactivescheme`: "Power Scheme GUID: <guid>  (Balanced)", localized.
    if let Some(plan) = get("plan")
        .and_then(|p| p.rsplit_once('(')?.1.strip_suffix(')'))
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        parts.push(format!("power plan {plan}"));
    }
    parts.join("; ")
}

/// From `sysctl -n` (brand, physical, logical) and `pmset -g batt`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn mac_summary(sysctl: &str, pmset: &str) -> String {
    let mut lines = sysctl.lines().map(str::trim);
    let name = lines.next().filter(|l| !l.is_empty());
    let cores = lines.next().and_then(|v| v.parse().ok());
    let threads = lines.next().and_then(|v| v.parse().ok());
    let power = if pmset.contains("'Battery Power'") {
        "on battery"
    } else if pmset.contains("'AC Power'") {
        "plugged in"
    } else {
        "power source unknown"
    };
    format!("{}; {power}", cpu_part(name, cores, threads))
}

fn cpu_part(name: Option<&str>, cores: Option<u32>, threads: Option<u32>) -> String {
    let name = name.map_or_else(
        || "unknown".to_owned(),
        |n| n.split_whitespace().collect::<Vec<_>>().join(" "),
    );
    match (cores, threads) {
        (Some(c), Some(t)) => format!("CPU {name} ({c} cores, {t} threads)"),
        _ => format!("CPU {name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_laptop_on_battery_in_efficiency_mode() {
        let out = "cpu=Intel(R) Core(TM) Ultra 5 125U   \r\ncores=12\r\nthreads=14\r\nbattery=1\r\n\
                   overlay_ac=00000000-0000-0000-0000-000000000000\r\n\
                   overlay_dc=961CC777-2547-4F9D-8174-7D86181B8A7A\r\n\
                   plan=GUID du mode de gestion de l'alimentation : 381b4222-f694-41f0-9685-ff5bb260df2e  (Utilisation normale)\r\n";
        assert_eq!(
            windows_summary(out),
            "CPU Intel(R) Core(TM) Ultra 5 125U (12 cores, 14 threads); on battery; \
             power mode best power efficiency; power plan Utilisation normale"
        );
    }

    #[test]
    fn windows_desktop_without_battery_or_overlay() {
        let out = "cpu=AMD Ryzen 7 5800X 8-Core Processor\ncores=8\nthreads=16\nbattery=\n\
                   overlay_ac=\noverlay_dc=\nplan=\n";
        assert_eq!(
            windows_summary(out),
            "CPU AMD Ryzen 7 5800X 8-Core Processor (8 cores, 16 threads); no battery"
        );
    }

    #[test]
    fn windows_plugged_in_in_best_performance() {
        let out = "cpu=X\ncores=4\nthreads=8\nbattery=2\n\
                   overlay_ac=ded574b5-45a0-4f42-8737-46345c09c238\noverlay_dc=x\n";
        assert_eq!(
            windows_summary(out),
            "CPU X (4 cores, 8 threads); plugged in; power mode best performance"
        );
        assert_eq!(windows_summary(""), "CPU unknown; no battery");
    }

    #[test]
    fn mac_summary_reads_sysctl_and_pmset() {
        let pmset =
            "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging";
        assert_eq!(
            mac_summary("Apple M2 Pro\n10\n10\n", pmset),
            "CPU Apple M2 Pro (10 cores, 10 threads); on battery"
        );
        assert_eq!(
            mac_summary("Apple M1\n", "Now drawing from 'AC Power'"),
            "CPU Apple M1; plugged in"
        );
    }
}
