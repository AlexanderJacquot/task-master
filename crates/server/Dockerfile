# task-master sync server image (docs/server.md). Build from the repo root:
#   docker build -f crates/server/Dockerfile -t task-master-server .
# Released by .forgejo/workflows/server-image.yml on v* tags.

FROM rust:1.99.1-slim-bookworm AS build
# Use the image's toolchain as is: rust-toolchain.toml would also ask for clippy/rustfmt.
ENV RUSTUP_TOOLCHAIN=1.99.1
WORKDIR /src
COPY . .
# Only the server and what it needs (the desktop app is a workspace member, not built).
RUN cargo build --release --locked -p taskmaster-server \
 && cp target/release/task-master-server /task-master-server

FROM gcr.io/distroless/cc-debian12
COPY --from=build /task-master-server /task-master-server
ENV TM_DATA_DIR=/data \
    TM_LISTEN=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/task-master-server", "health"]
ENTRYPOINT ["/task-master-server"]
CMD ["serve"]
