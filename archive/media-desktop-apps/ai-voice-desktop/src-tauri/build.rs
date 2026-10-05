#[cfg(target_os = "macos")]
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    configure_macos_python_link_shim();
    tauri_build::build();
}

fn configure_macos_python_link_shim() {
    #[cfg(target_os = "macos")]
    {
        let Some(python_binary) = find_python_framework_binary() else {
            return;
        };

        let out_dir = match env::var_os("OUT_DIR") {
            Some(out_dir) => PathBuf::from(out_dir),
            None => return,
        };
        let shim_dir = out_dir.join("pyo3-link-shim");
        if fs::create_dir_all(&shim_dir).is_err() {
            return;
        }

        let shim_path = shim_dir.join("libpython3.9.dylib");
        if !shim_path.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::symlink;
                let _ = symlink(&python_binary, &shim_path);
            }
        }

        if shim_path.exists() {
            println!("cargo:rustc-link-search=native={}", shim_dir.display());
            if let Some(rpath_root) = python_binary
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .and_then(Path::parent)
            {
                let rpath_flag = format!("-Wl,-rpath,{}", rpath_root.display());
                println!("cargo:rustc-link-arg={rpath_flag}");
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn find_python_framework_binary() -> Option<PathBuf> {
    let candidates = [
        "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Python3",
        "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Python3",
    ];

    candidates
        .iter()
        .map(Path::new)
        .find(|path| path.exists())
        .map(Path::to_path_buf)
}
