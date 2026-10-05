use std::time::Duration;
use tonic::transport::Channel;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};

/// User-friendly error types for UI display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserError {
    pub code: String,
    pub message: String,
    pub recovery_action: Option<String>,
    pub is_retryable: bool,
}

impl UserError {
    pub fn file_too_large(max_size_mb: u64) -> Self {
        Self {
            code: "FILE_TOO_LARGE".to_string(),
            message: format!("File exceeds maximum size limit of {} MB.", max_size_mb),
            recovery_action: Some("Please select a smaller file or split the file into chunks.".to_string()),
            is_retryable: false,
        }
    }

    pub fn invalid_file_type(expected: &str) -> Self {
        Self {
            code: "INVALID_FILE_TYPE".to_string(),
            message: format!("Invalid file type. Expected: {}", expected),
            recovery_action: Some("Please select a valid file type.".to_string()),
            is_retryable: false,
        }
    }

    pub fn circuit_breaker_open(service: &str) -> Self {
        Self {
            code: "CIRCUIT_BREAKER_OPEN".to_string(),
            message: format!("{} service is temporarily unavailable due to repeated failures.", service),
            recovery_action: Some("Please wait a moment and try again. The service will automatically recover.".to_string()),
            is_retryable: true,
        }
    }

    pub fn unavailable_with_context(service: &str, details: &str) -> Self {
        Self {
            code: "SERVICE_UNAVAILABLE".to_string(),
            message: format!("{} service is unavailable: {}", service, details),
            recovery_action: Some("Please wait a moment and retry the operation.".to_string()),
            is_retryable: true,
        }
    }

    pub fn processing_error(details: &str) -> Self {
        Self {
            code: "PROCESSING_ERROR".to_string(),
            message: format!("Error processing request: {}", details),
            recovery_action: Some("Please try again or contact support if the issue persists.".to_string()),
            is_retryable: true,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.message.clone())
    }
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Retry configuration for gRPC calls.
///
/// Values are read from environment variables at startup; the defaults shown
/// below apply when the variables are absent or malformed.
///
/// | Env variable                           | Default |
/// |----------------------------------------|---------|
/// | `GHATANA_RETRY_MAX_ATTEMPTS`           | 3       |
/// | `GHATANA_RETRY_INITIAL_DELAY_MS`       | 100     |
/// | `GHATANA_RETRY_MAX_DELAY_MS`           | 5000    |
/// | `GHATANA_RETRY_BACKOFF_MULTIPLIER`     | 2.0     |
#[derive(Debug, Clone)]
pub struct RetryConfig {
    pub max_attempts: u32,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
    pub backoff_multiplier: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: env_u32("GHATANA_RETRY_MAX_ATTEMPTS", 3),
            initial_delay_ms: env_u64("GHATANA_RETRY_INITIAL_DELAY_MS", 100),
            max_delay_ms: env_u64("GHATANA_RETRY_MAX_DELAY_MS", 5000),
            backoff_multiplier: env_f64("GHATANA_RETRY_BACKOFF_MULTIPLIER", 2.0),
        }
    }
}

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn env_f64(name: &str, default: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Retry a gRPC operation with exponential backoff
pub async fn retry_with_backoff<F, T, E>(
    operation: F,
    config: &RetryConfig,
) -> Result<T, String>
where
    F: Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, E>> + Send>>,
    E: std::fmt::Display,
{
    let mut delay_ms = config.initial_delay_ms;
    
    for attempt in 1..=config.max_attempts {
        match operation().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if attempt == config.max_attempts {
                    return Err(format!("Failed after {} attempts: {}", config.max_attempts, e));
                }
                
                log::warn!("Attempt {} failed: {}. Retrying in {}ms...", attempt, e, delay_ms);
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                
                delay_ms = (delay_ms as f64 * config.backoff_multiplier) as u64;
                delay_ms = delay_ms.min(config.max_delay_ms);
            }
        }
    }
    
    Err("Retry logic error".to_string())
}

/// Create a gRPC channel with timeout and retry
pub async fn create_channel_with_retry(addr: String) -> Result<Channel, String> {
    let config = RetryConfig::default();
    
    retry_with_backoff(
        || {
            let addr = addr.clone();
            Box::pin(async move {
                Channel::from_shared(addr)
                    .map_err(|e| e.to_string())?
                    .connect_timeout(Duration::from_secs(5))
                    .timeout(Duration::from_secs(30))
                    .connect()
                    .await
                    .map_err(|e| e.to_string())
            })
        },
        &config,
    )
    .await
}

/// Circuit breaker state
#[derive(Debug, Clone)]
pub struct CircuitBreaker {
    failure_threshold: u32,
    success_threshold: u32,
    timeout_ms: u64,
    failure_count: std::sync::Arc<std::sync::Mutex<u32>>,
    success_count: std::sync::Arc<std::sync::Mutex<u32>>,
    state: std::sync::Arc<std::sync::Mutex<CircuitState>>,
    last_failure_time: std::sync::Arc<std::sync::Mutex<Option<std::time::Instant>>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new(5, 2, 30000) // 5 failures, 2 successes, 30s timeout
    }
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, success_threshold: u32, timeout_ms: u64) -> Self {
        Self {
            failure_threshold,
            success_threshold,
            timeout_ms,
            failure_count: std::sync::Arc::new(std::sync::Mutex::new(0)),
            success_count: std::sync::Arc::new(std::sync::Mutex::new(0)),
            state: std::sync::Arc::new(std::sync::Mutex::new(CircuitState::Closed)),
            last_failure_time: std::sync::Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn on_success(&self) {
        let state = lock_or_recover(&self.state).clone();
        match state {
            CircuitState::Closed => {
                *lock_or_recover(&self.failure_count) = 0;
                *lock_or_recover(&self.success_count) = 0;
            }
            CircuitState::HalfOpen => {
                let mut success_count = lock_or_recover(&self.success_count);
                *success_count += 1;

                if *success_count >= self.success_threshold {
                    *lock_or_recover(&self.state) = CircuitState::Closed;
                    *lock_or_recover(&self.failure_count) = 0;
                    *success_count = 0;
                    *lock_or_recover(&self.last_failure_time) = None;
                    log::info!("Circuit breaker transitioned to CLOSED");
                }
            }
            CircuitState::Open => {}
        }
    }
    
    fn on_failure(&self) {
        let state = lock_or_recover(&self.state).clone();

        if state == CircuitState::HalfOpen {
            *lock_or_recover(&self.failure_count) = self.failure_threshold;
            *lock_or_recover(&self.success_count) = 0;
            *lock_or_recover(&self.state) = CircuitState::Open;
            *lock_or_recover(&self.last_failure_time) = Some(std::time::Instant::now());
            log::warn!("Circuit breaker transitioned back to OPEN from HALF_OPEN");
            return;
        }

        let mut failure_count = lock_or_recover(&self.failure_count);
        *failure_count += 1;
        *lock_or_recover(&self.success_count) = 0;

        if *failure_count >= self.failure_threshold {
            *lock_or_recover(&self.state) = CircuitState::Open;
            *lock_or_recover(&self.last_failure_time) = Some(std::time::Instant::now());
            log::warn!("Circuit breaker transitioned to OPEN");
        }
    }

    pub async fn call_async_for<F, Fut, T>(&self, service: &str, operation: F) -> Result<T, UserError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let state = lock_or_recover(&self.state).clone();
        
        match state {
            CircuitState::Open => {
                let last_failure = lock_or_recover(&self.last_failure_time);
                if let Some(time) = *last_failure {
                    if time.elapsed().as_millis() > self.timeout_ms as u128 {
                        drop(last_failure);
                        *lock_or_recover(&self.state) = CircuitState::HalfOpen;
                        *lock_or_recover(&self.success_count) = 0;
                    } else {
                        return Err(UserError::circuit_breaker_open(service));
                    }
                }
            }
            _ => {}
        }
        
        match operation().await {
            Ok(result) => {
                self.on_success();
                Ok(result)
            }
            Err(e) => {
                self.on_failure();
                Err(UserError::unavailable_with_context(service, &e))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn retry_with_backoff_eventually_succeeds_before_max_attempts() {
        let attempts = std::sync::Arc::new(std::sync::Mutex::new(0_u32));
        let attempts_for_operation = attempts.clone();
        let config = RetryConfig {
            max_attempts: 3,
            initial_delay_ms: 1,
            max_delay_ms: 2,
            backoff_multiplier: 1.0,
        };

        let result = retry_with_backoff(
            move || {
                let attempts = attempts_for_operation.clone();
                Box::pin(async move {
                    let mut guard = attempts.lock().unwrap_or_else(|e| e.into_inner());
                    *guard += 1;
                    if *guard < 3 {
                        Err("temporary failure")
                    } else {
                        Ok("ok")
                    }
                })
            },
            &config,
        )
        .await;

        assert_eq!(result.unwrap(), "ok");
        assert_eq!(*attempts.lock().unwrap_or_else(|e| e.into_inner()), 3);
    }

    #[tokio::test]
    async fn circuit_breaker_resets_failures_after_success_in_closed_state() {
        let breaker = CircuitBreaker::new(2, 1, 0);

        let first_error = breaker
            .call_async_for("STT", || async { Err::<(), String>("boom".to_string()) })
            .await
            .unwrap_err();
        assert_eq!(first_error.code, "SERVICE_UNAVAILABLE");
        assert_eq!(*lock_or_recover(&breaker.failure_count), 1);
        assert_eq!(*lock_or_recover(&breaker.state), CircuitState::Closed);

        let success = breaker
            .call_async_for("STT", || async { Ok::<_, String>("ok") })
            .await;
        assert_eq!(success.unwrap(), "ok");
        assert_eq!(*lock_or_recover(&breaker.failure_count), 0);
        assert_eq!(*lock_or_recover(&breaker.state), CircuitState::Closed);

        let second_error = breaker
            .call_async_for("STT", || async { Err::<(), String>("boom again".to_string()) })
            .await
            .unwrap_err();
        assert_eq!(second_error.code, "SERVICE_UNAVAILABLE");
        assert_eq!(*lock_or_recover(&breaker.failure_count), 1);
        assert_eq!(*lock_or_recover(&breaker.state), CircuitState::Closed);
    }

    #[tokio::test]
    async fn circuit_breaker_reopens_immediately_when_half_open_attempt_fails() {
        let breaker = CircuitBreaker::new(1, 2, 0);

        let open_error = breaker
            .call_async_for("TTS", || async { Err::<(), String>("initial failure".to_string()) })
            .await
            .unwrap_err();
        assert_eq!(open_error.code, "SERVICE_UNAVAILABLE");
        assert_eq!(*lock_or_recover(&breaker.state), CircuitState::Open);

        *lock_or_recover(&breaker.last_failure_time) =
            Some(std::time::Instant::now() - Duration::from_millis(1));

        let half_open_failure = breaker
            .call_async_for("TTS", || async { Err::<(), String>("probe failure".to_string()) })
            .await
            .unwrap_err();

        assert_eq!(half_open_failure.code, "SERVICE_UNAVAILABLE");
        assert_eq!(*lock_or_recover(&breaker.state), CircuitState::Open);
        assert_eq!(*lock_or_recover(&breaker.success_count), 0);
        assert_eq!(*lock_or_recover(&breaker.failure_count), 1);
    }

    #[test]
    fn retry_config_default_uses_hardcoded_values_when_env_vars_absent() {
        std::env::remove_var("GHATANA_RETRY_MAX_ATTEMPTS");
        std::env::remove_var("GHATANA_RETRY_INITIAL_DELAY_MS");
        std::env::remove_var("GHATANA_RETRY_MAX_DELAY_MS");
        std::env::remove_var("GHATANA_RETRY_BACKOFF_MULTIPLIER");

        let config = RetryConfig::default();
        assert_eq!(config.max_attempts, 3);
        assert_eq!(config.initial_delay_ms, 100);
        assert_eq!(config.max_delay_ms, 5000);
        assert!((config.backoff_multiplier - 2.0).abs() < f64::EPSILON);
    }

    #[test]
    fn retry_config_default_reads_max_attempts_from_env() {
        std::env::remove_var("GHATANA_RETRY_INITIAL_DELAY_MS");
        std::env::remove_var("GHATANA_RETRY_MAX_DELAY_MS");
        std::env::remove_var("GHATANA_RETRY_BACKOFF_MULTIPLIER");
        std::env::set_var("GHATANA_RETRY_MAX_ATTEMPTS", "7");

        let config = RetryConfig::default();
        assert_eq!(config.max_attempts, 7);
        assert_eq!(config.initial_delay_ms, 100);

        std::env::remove_var("GHATANA_RETRY_MAX_ATTEMPTS");
    }

    #[test]
    fn retry_config_default_reads_all_fields_from_env() {
        std::env::set_var("GHATANA_RETRY_MAX_ATTEMPTS", "5");
        std::env::set_var("GHATANA_RETRY_INITIAL_DELAY_MS", "50");
        std::env::set_var("GHATANA_RETRY_MAX_DELAY_MS", "2000");
        std::env::set_var("GHATANA_RETRY_BACKOFF_MULTIPLIER", "1.5");

        let config = RetryConfig::default();
        assert_eq!(config.max_attempts, 5);
        assert_eq!(config.initial_delay_ms, 50);
        assert_eq!(config.max_delay_ms, 2000);
        assert!((config.backoff_multiplier - 1.5).abs() < f64::EPSILON);

        std::env::remove_var("GHATANA_RETRY_MAX_ATTEMPTS");
        std::env::remove_var("GHATANA_RETRY_INITIAL_DELAY_MS");
        std::env::remove_var("GHATANA_RETRY_MAX_DELAY_MS");
        std::env::remove_var("GHATANA_RETRY_BACKOFF_MULTIPLIER");
    }

    #[test]
    fn retry_config_default_falls_back_for_malformed_env_values() {
        std::env::remove_var("GHATANA_RETRY_INITIAL_DELAY_MS");
        std::env::remove_var("GHATANA_RETRY_MAX_DELAY_MS");
        std::env::set_var("GHATANA_RETRY_MAX_ATTEMPTS", "not-a-number");
        std::env::set_var("GHATANA_RETRY_BACKOFF_MULTIPLIER", "bad");

        let config = RetryConfig::default();
        assert_eq!(config.max_attempts, 3);
        assert!((config.backoff_multiplier - 2.0).abs() < f64::EPSILON);

        std::env::remove_var("GHATANA_RETRY_MAX_ATTEMPTS");
        std::env::remove_var("GHATANA_RETRY_BACKOFF_MULTIPLIER");
    }
}
