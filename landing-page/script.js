const root = document.documentElement;
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const themeToggle = document.querySelector(".theme-toggle");
let chosenTheme;
try {
  chosenTheme = localStorage.getItem("movibox-landing-theme");
} catch {
  // Theme switching also works when browser storage is unavailable.
}

function applyTheme(theme) {
  root.dataset.theme = theme;
  themeToggle.setAttribute("aria-label", `Switch to ${theme === "dark" ? "light" : "dark"} theme`);
  document.querySelector('meta[name="theme-color"]').content =
    theme === "dark" ? "#111214" : "#f5f5f4";
}

applyTheme(
  chosenTheme === "light" || chosenTheme === "dark"
    ? chosenTheme
    : systemTheme.matches
      ? "dark"
      : "light",
);
themeToggle.addEventListener("click", () => {
  chosenTheme = root.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(chosenTheme);
  try {
    localStorage.setItem("movibox-landing-theme", chosenTheme);
  } catch {
    // A storage restriction does not prevent the current theme from changing.
  }
});
systemTheme.addEventListener("change", (event) => {
  if (!chosenTheme) applyTheme(event.matches ? "dark" : "light");
});

const menuToggle = document.querySelector(".menu-toggle");
const mobileNav = document.querySelector(".mobile-nav");
function closeMenu() {
  mobileNav.hidden = true;
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.setAttribute("aria-label", "Open navigation");
}
menuToggle.addEventListener("click", () => {
  const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
  mobileNav.hidden = isOpen;
  menuToggle.setAttribute("aria-expanded", String(!isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "Open navigation" : "Close navigation");
});
mobileNav.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !mobileNav.hidden) {
    closeMenu();
    menuToggle.focus();
  }
});
window.matchMedia("(min-width: 768px)").addEventListener("change", (event) => {
  if (event.matches) closeMenu();
});

const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
const descriptions = {
  discover: "Browse movies, series, and collections through your Stremio-compatible catalogs.",
  downloads: "Keep an eye on your queue. Pause, resume, and retry downloads in one place.",
  library: "Find completed downloads and open your files in the external app you choose.",
};
function selectTab(tab) {
  tabs.forEach((item) => {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(item.getAttribute("aria-controls"));
    panel.hidden = !selected;
    panel.classList.toggle("is-entering", selected);
  });
  document.getElementById("preview-description").textContent =
    descriptions[tab.id.replace("tab-", "")];
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (event) => {
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    tabs[next].focus();
    selectTab(tabs[next]);
  });
});

const platforms = {
  macos: {
    label: "macOS",
    requirement: "macOS 11 or later",
    note: "This build is not Apple-notarized. macOS may show a security prompt when opening it.",
    installers: [
      ["Mac with Apple Silicon", "aarch64.dmg"],
      ["Mac with Intel", "x64.dmg"],
    ],
  },
  windows: {
    label: "Windows",
    requirement: "64-bit Windows",
    note: "This build is not Authenticode-signed. Windows may show a security prompt when opening it.",
    installers: [["Windows x64 installer", "x64-setup.exe"]],
  },
  linux: {
    label: "Linux",
    requirement: "x64 or ARM64 desktop Linux",
    note: "Choose AppImage for a portable app, or DEB for a Debian-based distribution. Check the release notes for build details.",
    installers: [
      ["AppImage · x64", "amd64.AppImage"],
      ["AppImage · ARM64", "aarch64.AppImage"],
      ["DEB · x64", "amd64.deb"],
      ["DEB · ARM64", "arm64.deb"],
    ],
  },
};
const installerSelect = document.getElementById("installer");
const downloadLink = document.getElementById("download-link");
function updateDownload() {
  downloadLink.href = `https://github.com/blackridder22/Movibox/releases/download/v0.9.22/${installerSelect.value}`;
}
function selectPlatform(key) {
  const platform = platforms[key];
  installerSelect.replaceChildren(
    ...platform.installers.map(([label, suffix]) => new Option(label, `MoviBox_0.9.22_${suffix}`)),
  );
  document.getElementById("system-requirement").textContent = platform.requirement;
  document.getElementById("install-note").textContent = platform.note;
  downloadLink.querySelector("span").textContent = `Download for ${platform.label}`;
  document.querySelector(`input[name="platform"][value="${key}"]`).checked = true;
  updateDownload();
}
document
  .querySelectorAll('input[name="platform"]')
  .forEach((radio) => radio.addEventListener("change", () => selectPlatform(radio.value)));
installerSelect.addEventListener("change", updateDownload);
const agent = navigator.userAgent;
if (/Windows/i.test(agent)) selectPlatform("windows");
else if (/Linux/i.test(agent) && !/Android/i.test(agent)) selectPlatform("linux");

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-entering");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08 },
  );
  document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
}
