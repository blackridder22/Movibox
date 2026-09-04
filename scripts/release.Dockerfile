FROM node:24-bookworm-slim AS node
FROM rust:1.96-bookworm
COPY --from=node /usr/local/ /usr/local/
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev \
    librsvg2-dev libasound2-dev libgtk-3-dev patchelf xvfb xauth dbus-x11 \
    ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.9.0
ENV npm_config_manage_package_manager_versions=false
WORKDIR /workspace
