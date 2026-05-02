FROM rust:1.86-bookworm AS build

WORKDIR /app

COPY ./rust-core ./rust-core

RUN cargo build --release --features io-uring --manifest-path rust-core/Cargo.toml

FROM debian:bookworm-slim

EXPOSE 8080

WORKDIR /app

ENV FEARLESS_WORKERS=32

COPY --from=build /app/rust-core/target/release/fearless-core /app/fearless-core

USER nobody

CMD ["/app/fearless-core", "--port", "8080"]
