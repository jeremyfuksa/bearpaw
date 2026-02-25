use std::path::PathBuf;

pub fn get_app_data_dir() -> PathBuf {
    let path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut result = PathBuf::from(&path);
    result.push("Bearpaw");
    result
}

pub fn get_recordings_dir() -> PathBuf {
    let mut path = get_app_data_dir();
    path.push("recordings");
    path
}

pub fn get_config_dir() -> PathBuf {
    get_app_data_dir()
}
