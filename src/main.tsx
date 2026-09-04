// Load only the chosen client; the preview never mounts legacy automation.
if (new URLSearchParams(window.location.search).get("legacy") === "1") {
  void import("./legacy-main");
} else {
  void import("./moviebox/bootstrap");
}
