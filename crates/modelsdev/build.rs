use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?);
    let repo_root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| io::Error::other("failed to resolve repo root"))?;
    let providers_dir = repo_root.join("providers");
    let out_dir = PathBuf::from(env::var("OUT_DIR")?);
    let catalog_path = out_dir.join("catalog.json");

    println!("cargo:rerun-if-changed={}", providers_dir.display());

    let catalog = serde_json::json!({
        "providers": build_catalog(&providers_dir)?,
    });
    let json = serde_json::to_string(&catalog)?;
    fs::write(catalog_path, json)?;
    Ok(())
}

fn build_catalog(providers_dir: &Path) -> Result<BTreeMap<String, serde_json::Value>, io::Error> {
    let mut providers = BTreeMap::new();
    for entry in fs::read_dir(providers_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let provider_id = entry.file_name().to_string_lossy().to_string();
        let provider_dir = entry.path();
        let provider_toml = provider_dir.join("provider.toml");
        if !provider_toml.is_file() {
            continue;
        }

        let mut provider = read_toml_value(&provider_toml)?;
        let Some(provider_object) = provider.as_object_mut() else {
            return Err(io::Error::other(format!(
                "provider TOML must be an object: {}",
                provider_toml.display()
            )));
        };
        let _ = provider_object.insert(
            "id".to_owned(),
            serde_json::Value::String(provider_id.clone()),
        );
        let _ = provider_object.insert(
            "models".to_owned(),
            serde_json::Value::Object(serde_json::Map::new()),
        );

        let models_dir = provider_dir.join("models");
        if models_dir.is_dir() {
            let mut models = BTreeMap::new();
            collect_models(&models_dir, &models_dir, &mut models)?;
            let models_object = models.into_iter().collect::<serde_json::Map<String, _>>();
            let _ = provider_object.insert(
                "models".to_owned(),
                serde_json::Value::Object(models_object),
            );
        }

        let _ = providers.insert(provider_id, provider);
    }
    Ok(providers)
}

fn collect_models(
    models_dir: &Path,
    current_dir: &Path,
    models: &mut BTreeMap<String, serde_json::Value>,
) -> Result<(), io::Error> {
    for entry in fs::read_dir(current_dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_models(models_dir, &path, models)?;
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("toml") || !path.is_file() {
            continue;
        }
        let relative = path.strip_prefix(models_dir).map_err(io::Error::other)?;
        let model_id = relative
            .to_string_lossy()
            .strip_suffix(".toml")
            .unwrap_or_default()
            .replace('\\', "/");
        let mut model = read_toml_value(&path)?;
        let Some(model_object) = model.as_object_mut() else {
            return Err(io::Error::other(format!(
                "model TOML must be an object: {}",
                path.display()
            )));
        };
        let _ = model_object.insert("id".to_owned(), serde_json::Value::String(model_id.clone()));
        let _ = models.insert(model_id, model);
    }
    Ok(())
}

fn read_toml_value(path: &Path) -> Result<serde_json::Value, io::Error> {
    let text = fs::read_to_string(path)?;
    let toml_value = toml::from_str::<toml::Value>(&text).map_err(io::Error::other)?;
    serde_json::to_value(toml_value).map_err(io::Error::other)
}
