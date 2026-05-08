//! Build a deadpool-postgres pool from `FEARLESS_SQL_PRIMARY` env URL.
//!
//! Pool sizing: defaults to `num_cpus()` connections. Override with
//! `FEARLESS_SQL_PRIMARY_POOL_SIZE`. Fail fast if the URL is missing or the
//! pool can't establish a connection at startup.

use deadpool_postgres::{Config, Pool, Runtime};
use std::env;

#[derive(Debug)]
pub enum PoolBuildError {
    MissingUrl,
    InvalidUrl(String),
    InvalidPoolSize(String),
    PoolBuild(String),
    InitialConnect(String),
}

impl std::fmt::Display for PoolBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingUrl => write!(f, "FEARLESS_SQL_PRIMARY env var not set"),
            Self::InvalidUrl(s) => write!(f, "invalid FEARLESS_SQL_PRIMARY: {s}"),
            Self::InvalidPoolSize(s) => write!(f, "invalid FEARLESS_SQL_PRIMARY_POOL_SIZE: {s}"),
            Self::PoolBuild(s) => write!(f, "deadpool build failed: {s}"),
            Self::InitialConnect(s) => write!(f, "could not connect to Postgres at startup: {s}"),
        }
    }
}

impl std::error::Error for PoolBuildError {}

pub async fn build_primary_pool() -> Result<Pool, PoolBuildError> {
    let url = env::var("FEARLESS_SQL_PRIMARY").map_err(|_| PoolBuildError::MissingUrl)?;

    let pool_size: usize = env::var("FEARLESS_SQL_PRIMARY_POOL_SIZE")
        .ok()
        .map(|s| s.parse().map_err(|e: std::num::ParseIntError| PoolBuildError::InvalidPoolSize(e.to_string())))
        .transpose()?
        .unwrap_or_else(num_cpus::get);

    let pg_config: tokio_postgres::Config = url
        .parse()
        .map_err(|e: tokio_postgres::Error| PoolBuildError::InvalidUrl(e.to_string()))?;

    let mut cfg = Config::new();
    cfg.host = pg_config.get_hosts().first().and_then(|h| match h {
        tokio_postgres::config::Host::Tcp(s) => Some(s.clone()),
        _ => None,
    });
    cfg.port = pg_config.get_ports().first().copied();
    cfg.user = pg_config.get_user().map(|s| s.to_string());
    cfg.password = pg_config
        .get_password()
        .and_then(|p| std::str::from_utf8(p).ok().map(|s| s.to_string()));
    cfg.dbname = pg_config.get_dbname().map(|s| s.to_string());

    let mut pool_cfg = deadpool_postgres::PoolConfig::new(pool_size);
    pool_cfg.timeouts.wait = Some(std::time::Duration::from_secs(2));
    cfg.pool = Some(pool_cfg);

    let pool = cfg
        .create_pool(Some(Runtime::Tokio1), tokio_postgres::NoTls)
        .map_err(|e| PoolBuildError::PoolBuild(e.to_string()))?;

    let client = pool
        .get()
        .await
        .map_err(|e| PoolBuildError::InitialConnect(e.to_string()))?;
    let _ = client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| PoolBuildError::InitialConnect(e.to_string()))?;
    drop(client);

    Ok(pool)
}
