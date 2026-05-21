#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use thiserror::Error;

static CATALOG: OnceLock<Catalog> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Catalog {
    pub providers: BTreeMap<String, Provider>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Provider {
    pub id: String,
    pub env: Vec<String>,
    pub npm: String,
    pub api: Option<String>,
    pub name: String,
    pub doc: String,
    pub models: BTreeMap<String, Model>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub family: Option<String>,
    pub attachment: bool,
    pub reasoning: bool,
    pub tool_call: bool,
    pub interleaved: Option<Interleaved>,
    pub structured_output: Option<bool>,
    pub temperature: Option<bool>,
    pub knowledge: Option<String>,
    pub release_date: String,
    pub last_updated: String,
    pub modalities: Modalities,
    pub open_weights: bool,
    pub cost: Option<Cost>,
    pub limit: Limit,
    pub status: Option<ModelStatus>,
    pub provider: Option<ModelProvider>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Interleaved {
    Enabled(bool),
    Field(InterleavedField),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterleavedField {
    pub field: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Modalities {
    pub input: Vec<String>,
    pub output: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cost {
    pub input: f64,
    pub output: f64,
    pub reasoning: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub input_audio: Option<f64>,
    pub output_audio: Option<f64>,
    pub context_over_200k: Option<Box<Cost>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Limit {
    pub context: i64,
    pub input: Option<i64>,
    pub output: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelStatus {
    Alpha,
    Beta,
    Deprecated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelProvider {
    pub npm: Option<String>,
    pub api: Option<String>,
    pub shape: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderTransport {
    pub npm: String,
    pub api: Option<String>,
    pub shape: Option<String>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum LookupError {
    #[error("unknown provider: {provider_id}")]
    UnknownProvider { provider_id: String },
    #[error("unknown model for provider {provider_id}: {model_id}")]
    UnknownModel {
        provider_id: String,
        model_id: String,
    },
}

#[must_use]
pub fn catalog() -> &'static Catalog {
    CATALOG.get_or_init(|| {
        serde_json::from_str(CATALOG_JSON).expect("embedded modelsdev catalog must stay valid")
    })
}

impl Catalog {
    pub fn provider(&self, provider_id: &str) -> Result<&Provider, LookupError> {
        self.providers
            .get(provider_id.trim())
            .ok_or_else(|| LookupError::UnknownProvider {
                provider_id: provider_id.trim().to_owned(),
            })
    }

    pub fn model(&self, provider_id: &str, model_id: &str) -> Result<&Model, LookupError> {
        let provider = self.provider(provider_id)?;
        provider.model(model_id)
    }

    #[must_use]
    pub fn supported_provider_ids(&self) -> Vec<&str> {
        self.providers
            .values()
            .filter(|provider| provider.transport(None).family().is_some())
            .map(|provider| provider.id.as_str())
            .collect()
    }
}

impl Provider {
    pub fn model(&self, model_id: &str) -> Result<&Model, LookupError> {
        self.models
            .get(model_id.trim())
            .ok_or_else(|| LookupError::UnknownModel {
                provider_id: self.id.clone(),
                model_id: model_id.trim().to_owned(),
            })
    }

    #[must_use]
    pub fn transport(&self, model: Option<&Model>) -> ProviderTransport {
        let model_provider = model.and_then(|value| value.provider.as_ref());
        ProviderTransport {
            npm: model_provider
                .and_then(|value| value.npm.clone())
                .unwrap_or_else(|| self.npm.clone()),
            api: model_provider
                .and_then(|value| value.api.clone())
                .or_else(|| self.api.clone()),
            shape: model_provider.and_then(|value| value.shape.clone()),
        }
    }
}

impl ProviderTransport {
    #[must_use]
    pub fn family(&self) -> Option<&'static str> {
        match self.npm.as_str() {
            "@ai-sdk/anthropic" => Some("anthropic"),
            "@ai-sdk/openai" | "@ai-sdk/openai-compatible" => Some("openai"),
            _ => None,
        }
    }

    #[must_use]
    pub fn base_url(&self) -> Option<&str> {
        if let Some(api) = self.api.as_deref() {
            return Some(api);
        }
        match self.npm.as_str() {
            "@ai-sdk/anthropic" => Some("https://api.anthropic.com"),
            "@ai-sdk/openai" => Some("https://api.openai.com/v1"),
            _ => None,
        }
    }
}

const CATALOG_JSON: &str = include_str!(concat!(env!("OUT_DIR"), "/catalog.json"));

#[cfg(test)]
mod tests;
