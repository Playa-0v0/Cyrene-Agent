fn main() {
    if let Err(error) = cyrene_screenshot::cli::run() {
        if let cyrene_screenshot::error::AppError::ProtocolVersionMismatch { provided, expected } =
            &error
        {
            let event = cyrene_screenshot::protocol::Event::Error {
                request_id: None,
                code: error.code().into(),
                message: format!("unsupported protocol version {provided}; expected {expected}"),
                recoverable: false,
            };
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            if let Err(write_error) = cyrene_screenshot::ipc::write_event(&mut stdout, &event) {
                eprintln!("failed to write protocol error: {write_error}");
            }
        } else {
            eprintln!("{error}");
        }
        std::process::exit(1);
    }
}
