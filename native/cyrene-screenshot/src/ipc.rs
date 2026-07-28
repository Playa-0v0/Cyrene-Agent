use std::{
    io::{self, BufRead, BufReader, Write},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    thread,
};

use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    UI::WindowsAndMessaging::PostMessageW,
};

use crate::{
    WM_APP_COMMAND, WM_APP_SHUTDOWN,
    protocol::{Command, Event, MAX_NDJSON_LINE_BYTES, parse_command_line},
};

pub struct RuntimeChannels {
    pub command_rx: Receiver<Command>,
    pub event_tx: Sender<Event>,
}

#[derive(Clone)]
pub struct InputGate {
    inner: Arc<Mutex<InputGateState>>,
    target: MessageTarget,
}

struct InputGateState {
    command_sender: Option<Sender<Command>>,
    event_sender: Option<Sender<Event>>,
    deferred_command: Option<Command>,
    deferred_event: Option<Event>,
    wake_pending: bool,
    closed: bool,
}

pub struct InputBatch {
    pub commands: Vec<Command>,
    pub events: Vec<Event>,
}

#[derive(Clone, Copy)]
pub struct MessageTarget(usize);

impl MessageTarget {
    pub fn new(hwnd: HWND) -> Self {
        Self(hwnd.0 as usize)
    }

    pub fn post(self, message: u32) -> windows::core::Result<()> {
        let hwnd = HWND(self.0 as *mut _);
        // SAFETY: The HWND was created before MessageTarget was published. Message
        // parameters are deliberately zero; all command data stays in the channel.
        unsafe { PostMessageW(Some(hwnd), message, WPARAM(0), LPARAM(0)) }
    }
}

pub fn create_runtime_channels(
    target: MessageTarget,
) -> (RuntimeChannels, InputGate, Receiver<Event>, Receiver<Event>) {
    let (command_sender, command_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    let (input_event_sender, input_event_rx) = mpsc::channel();
    (
        RuntimeChannels {
            command_rx,
            event_tx,
        },
        InputGate {
            inner: Arc::new(Mutex::new(InputGateState {
                command_sender: Some(command_sender),
                event_sender: Some(input_event_sender),
                deferred_command: None,
                deferred_event: None,
                wake_pending: false,
                closed: false,
            })),
            target,
        },
        event_rx,
        input_event_rx,
    )
}

impl InputGate {
    pub fn submit_command(&self, command: Command) -> bool {
        let mut state = self.lock_state();
        if state.closed
            || state
                .command_sender
                .as_ref()
                .is_none_or(|sender| sender.send(command).is_err())
        {
            return false;
        }
        self.ensure_wake(&mut state)
    }

    pub fn submit_event(&self, event: Event) -> bool {
        let mut state = self.lock_state();
        if state.closed
            || state
                .event_sender
                .as_ref()
                .is_none_or(|sender| sender.send(event).is_err())
        {
            return false;
        }
        self.ensure_wake(&mut state)
    }

    pub fn drain_batch(
        &self,
        command_rx: &Receiver<Command>,
        event_rx: &Receiver<Event>,
        limit_per_queue: usize,
    ) -> InputBatch {
        let mut state = self.lock_state();
        let (commands, command_backlog) =
            receive_batch(&mut state.deferred_command, command_rx, limit_per_queue);
        let (events, event_backlog) =
            receive_batch(&mut state.deferred_event, event_rx, limit_per_queue);

        if command_backlog || event_backlog {
            state.wake_pending = true;
            if self.target.post(WM_APP_COMMAND).is_err() {
                state.wake_pending = false;
            }
        } else {
            state.wake_pending = false;
        }

        InputBatch { commands, events }
    }

    pub fn close(&self) -> Vec<Event> {
        let (command_sender, event_sender, deferred_event) = {
            let mut state = self.lock_state();
            state.closed = true;
            state.wake_pending = false;
            state.deferred_command.take();
            (
                state.command_sender.take(),
                state.event_sender.take(),
                state.deferred_event.take(),
            )
        };
        drop(command_sender);
        drop(event_sender);
        deferred_event.into_iter().collect()
    }

    fn ensure_wake(&self, state: &mut InputGateState) -> bool {
        if state.wake_pending {
            return true;
        }
        state.wake_pending = true;
        if self.target.post(WM_APP_COMMAND).is_err() {
            state.wake_pending = false;
            return false;
        }
        true
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, InputGateState> {
        self.inner.lock().unwrap_or_else(|error| {
            eprintln!("input gate mutex was poisoned; recovering");
            error.into_inner()
        })
    }
}

fn receive_batch<T>(
    deferred: &mut Option<T>,
    receiver: &Receiver<T>,
    limit: usize,
) -> (Vec<T>, bool) {
    let mut items = Vec::with_capacity(limit);
    if let Some(item) = deferred.take() {
        items.push(item);
    }
    while items.len() < limit {
        match receiver.try_recv() {
            Ok(item) => items.push(item),
            Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => {
                return (items, false);
            }
        }
    }
    match receiver.try_recv() {
        Ok(item) => {
            *deferred = Some(item);
            (items, true)
        }
        Err(mpsc::TryRecvError::Empty | mpsc::TryRecvError::Disconnected) => (items, false),
    }
}

pub fn spawn_stdin_reader(target: MessageTarget, input_gate: InputGate) {
    thread::Builder::new()
        .name("cyrene-stdin".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            loop {
                match read_capped_line(&mut reader) {
                    Ok(InputLine::Line(bytes)) => {
                        let parsed = std::str::from_utf8(&bytes)
                            .map_err(|error| {
                                (
                                    "invalid-command",
                                    format!("invalid command: input is not UTF-8: {error}"),
                                )
                            })
                            .and_then(|line| {
                                parse_command_line(line)
                                    .map_err(|error| (error.code(), error.to_string()))
                            });
                        match parsed {
                            Ok(command) => {
                                let shutdown = matches!(command, Command::Shutdown);
                                if !input_gate.submit_command(command) {
                                    return;
                                }
                                if shutdown {
                                    return;
                                }
                            }
                            Err((code, message)) => {
                                if !input_gate.submit_event(Event::Error {
                                    request_id: None,
                                    code: code.into(),
                                    message,
                                    recoverable: true,
                                }) {
                                    return;
                                }
                            }
                        }
                    }
                    Ok(InputLine::TooLong) => {
                        if !input_gate.submit_event(Event::Error {
                            request_id: None,
                            code: "line-too-long".into(),
                            message: format!("NDJSON line exceeds {MAX_NDJSON_LINE_BYTES} bytes"),
                            recoverable: true,
                        }) {
                            return;
                        }
                    }
                    Ok(InputLine::Eof) => {
                        let _ = target.post(WM_APP_SHUTDOWN);
                        return;
                    }
                    Err(error) => {
                        eprintln!("stdin reader failed: {error}");
                        let _ = target.post(WM_APP_SHUTDOWN);
                        return;
                    }
                }
            }
        })
        .expect("failed to start stdin reader");
}

pub fn spawn_stdout_writer(event_rx: Receiver<Event>) -> thread::JoinHandle<io::Result<()>> {
    thread::Builder::new()
        .name("cyrene-stdout".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut stdout = stdout.lock();
            for event in event_rx {
                write_event(&mut stdout, &event)?;
            }
            Ok(())
        })
        .expect("failed to start stdout writer")
}

pub fn write_event(writer: &mut impl Write, event: &Event) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, event).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

enum InputLine {
    Line(Vec<u8>),
    TooLong,
    Eof,
}

fn read_capped_line(reader: &mut impl BufRead) -> io::Result<InputLine> {
    let mut line = Vec::new();
    let mut too_long = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if too_long {
                Ok(InputLine::TooLong)
            } else if line.is_empty() {
                Ok(InputLine::Eof)
            } else {
                Ok(InputLine::Line(line))
            };
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(available.len());
        if !too_long {
            if line.len() + content_len > MAX_NDJSON_LINE_BYTES {
                too_long = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..content_len]);
            }
        }
        let consumed = content_len + usize::from(newline.is_some());
        reader.consume(consumed);

        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return if too_long {
                Ok(InputLine::TooLong)
            } else {
                Ok(InputLine::Line(line))
            };
        }
    }
}
