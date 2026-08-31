use crate::{error::AppError, protocol::PROTOCOL_VERSION};
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOptions {
    pub output_dir: PathBuf,
    pub protocol_version: u32,
    pub parent_pid: u32,
}

pub fn parse_arguments<I, S>(arguments: I) -> Result<CliOptions, AppError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut arguments = arguments.into_iter().map(Into::into);
    let mut output_dir = None;
    let mut protocol_version = None;
    let mut parent_pid = None;

    while let Some(argument) = arguments.next() {
        let mut value = || {
            arguments
                .next()
                .ok_or_else(|| AppError::InvalidArguments(format!("missing value for {argument}")))
        };

        match argument.as_str() {
            "--output-dir" => {
                if output_dir.replace(PathBuf::from(value()?)).is_some() {
                    return Err(AppError::InvalidArguments(
                        "--output-dir was provided more than once".into(),
                    ));
                }
            }
            "--protocol-version" => {
                let version = value()?.parse().map_err(|_| {
                    AppError::InvalidArguments("--protocol-version must be a u32".into())
                })?;
                if protocol_version.replace(version).is_some() {
                    return Err(AppError::InvalidArguments(
                        "--protocol-version was provided more than once".into(),
                    ));
                }
            }
            "--parent-pid" => {
                let pid = value()?
                    .parse()
                    .map_err(|_| AppError::InvalidArguments("--parent-pid must be a u32".into()))?;
                if parent_pid.replace(pid).is_some() {
                    return Err(AppError::InvalidArguments(
                        "--parent-pid was provided more than once".into(),
                    ));
                }
            }
            _ => {
                return Err(AppError::InvalidArguments(format!(
                    "unknown argument {argument}"
                )));
            }
        }
    }

    let output_dir =
        output_dir.ok_or_else(|| AppError::InvalidArguments("--output-dir is required".into()))?;
    if !output_dir.is_absolute() {
        return Err(AppError::InvalidArguments(
            "--output-dir must be an absolute path".into(),
        ));
    }

    let protocol_version = protocol_version
        .ok_or_else(|| AppError::InvalidArguments("--protocol-version is required".into()))?;
    if protocol_version != PROTOCOL_VERSION {
        return Err(AppError::ProtocolVersionMismatch {
            provided: protocol_version,
            expected: PROTOCOL_VERSION,
        });
    }

    Ok(CliOptions {
        output_dir,
        protocol_version,
        parent_pid: parent_pid
            .ok_or_else(|| AppError::InvalidArguments("--parent-pid is required".into()))?,
    })
}

pub fn run() -> Result<(), AppError> {
    let options = parse_arguments(std::env::args().skip(1))?;
    crate::app::run(options)
}
