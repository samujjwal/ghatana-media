use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};

pub struct CircuitBreaker {
    name: &'static str,
    failure_threshold: u32,
    cooldown: Duration,
    state: Mutex<BreakerState>,
}

#[derive(Debug)]
struct BreakerState {
    consecutive_failures: u32,
    opened_at: Option<Instant>,
}

impl CircuitBreaker {
    pub fn new(name: &'static str, failure_threshold: u32, cooldown: Duration) -> Self {
        Self {
            name,
            failure_threshold: failure_threshold.max(1),
            cooldown,
            state: Mutex::new(BreakerState {
                consecutive_failures: 0,
                opened_at: None,
            }),
        }
    }

    pub fn run<T, F>(&self, operation: &str, action: F) -> AppResult<T>
    where
        F: FnOnce() -> AppResult<T>,
    {
        self.ensure_available(operation)?;
        match action() {
            Ok(value) => {
                self.record_success();
                Ok(value)
            }
            Err(error) => {
                self.record_failure();
                Err(error)
            }
        }
    }

    fn ensure_available(&self, operation: &str) -> AppResult<()> {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(opened_at) = state.opened_at {
            if opened_at.elapsed() < self.cooldown {
                return Err(AppError::Audio(format!(
                    "{} circuit open for {}",
                    self.name, operation
                )));
            }
            state.opened_at = None;
            state.consecutive_failures = 0;
        }
        Ok(())
    }

    fn record_success(&self) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.consecutive_failures = 0;
        state.opened_at = None;
    }

    fn record_failure(&self) {
        let mut state = self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        state.consecutive_failures += 1;
        if state.consecutive_failures >= self.failure_threshold {
            state.opened_at = Some(Instant::now());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circuit_breaker_opens_after_threshold() {
        let breaker = CircuitBreaker::new("test", 2, Duration::from_millis(25));
        let _: AppResult<()> = breaker.run("decode", || Err(AppError::Audio("fail".to_string())));
        let _: AppResult<()> = breaker.run("decode", || Err(AppError::Audio("fail".to_string())));

        let result = breaker.run("decode", || Ok::<_, AppError>(()));
        assert!(result.is_err());
    }

    #[test]
    fn circuit_breaker_recovers_after_cooldown() {
        let breaker = CircuitBreaker::new("test", 1, Duration::from_millis(5));
        let _: AppResult<()> = breaker.run("decode", || Err(AppError::Audio("fail".to_string())));
        std::thread::sleep(Duration::from_millis(10));

        let result = breaker.run("decode", || Ok::<_, AppError>(42));
        assert_eq!(result.unwrap(), 42);
    }
}