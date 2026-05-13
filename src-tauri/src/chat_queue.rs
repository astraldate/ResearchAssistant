use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::sync::{oneshot, Mutex};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChatPriority {
    Desktop = 0,
    Mobile = 1,
}

#[derive(Clone, Default)]
pub struct LlmChatQueueState {
    inner: Arc<Mutex<QueueInner>>,
    sequence: Arc<AtomicU64>,
}

#[derive(Default)]
struct QueueInner {
    running: bool,
    jobs: VecDeque<QueuedJob>,
}

struct QueuedJob {
    priority: ChatPriority,
    sequence: u64,
    sender: oneshot::Sender<()>,
}

pub struct ChatQueuePermit {
    state: LlmChatQueueState,
    released: bool,
}

impl LlmChatQueueState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn acquire(&self, priority: ChatPriority) -> ChatQueuePermit {
        let (sender, receiver) = oneshot::channel();
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst);
        let mut start_now = false;

        {
            let mut inner = self.inner.lock().await;
            if !inner.running && inner.jobs.is_empty() {
                inner.running = true;
                start_now = true;
            } else {
                inner.jobs.push_back(QueuedJob {
                    priority,
                    sequence,
                    sender,
                });
            }
        }

        if !start_now {
            let _ = receiver.await;
        }

        ChatQueuePermit {
            state: self.clone(),
            released: false,
        }
    }

    async fn release_next(&self) {
        let next = {
            let mut inner = self.inner.lock().await;
            if inner.jobs.is_empty() {
                inner.running = false;
                None
            } else {
                let next_index = inner
                    .jobs
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, job)| (job.priority, job.sequence))
                    .map(|(index, _)| index)
                    .unwrap_or(0);
                inner.jobs.remove(next_index)
            }
        };

        if let Some(job) = next {
            let _ = job.sender.send(());
        }
    }
}

impl ChatQueuePermit {
    pub async fn release(mut self) {
        if !self.released {
            self.released = true;
            self.state.release_next().await;
        }
    }
}

impl Drop for ChatQueuePermit {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let state = self.state.clone();
        tauri::async_runtime::spawn(async move {
            state.release_next().await;
        });
    }
}
