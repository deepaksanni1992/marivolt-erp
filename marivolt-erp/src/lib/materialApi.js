import { apiGetWithQuery, apiPost, apiPut, apiDelete } from "./api.js";

// Verticals
export function fetchVerticalList(params) {
  return apiGetWithQuery("/verticals", params);
}

export function createVertical(data) {
  return apiPost("/verticals", data);
}

export function updateVertical(id, data) {
  return apiPut(`/verticals/${id}`, data);
}

export function deleteVertical(id) {
  return apiDelete(`/verticals/${id}`);
}

// Brands (scoped to vertical)
export function fetchBrandList(params) {
  return apiGetWithQuery("/brands", params);
}

export function createBrand(data) {
  return apiPost("/brands", data);
}

export function updateBrand(id, data) {
  return apiPut(`/brands/${id}`, data);
}

export function deleteBrand(id) {
  return apiDelete(`/brands/${id}`);
}

// Engine models (scoped to brand)
export function fetchEngineModelList(params) {
  return apiGetWithQuery("/engine-models", params);
}

export function createEngineModel(data) {
  return apiPost("/engine-models", data);
}

export function updateEngineModel(id, data) {
  return apiPut(`/engine-models/${id}`, data);
}

export function deleteEngineModel(id) {
  return apiDelete(`/engine-models/${id}`);
}

// Resolve material (SPN + brand + engine context)
export function resolveMaterialLookup(body) {
  return apiPost("/resolve-material", body);
}

// SPN Master
export function fetchSpnList(params) {
  return apiGetWithQuery("/spn", params);
}

export function createSpn(data) {
  return apiPost("/spn", data);
}

export function updateSpn(id, data) {
  return apiPut(`/spn/${id}`, data);
}

export function deleteSpn(id) {
  return apiDelete(`/spn/${id}`);
}

// Material Master
export function fetchMaterialList(params) {
  return apiGetWithQuery("/materials", params);
}

export function createMaterial(data) {
  return apiPost("/materials", data);
}

export function updateMaterial(id, data) {
  return apiPut(`/materials/${id}`, data);
}

export function deleteMaterial(id) {
  return apiDelete(`/materials/${id}`);
}

// Material Compatibility
export function fetchMaterialCompatList(params) {
  return apiGetWithQuery("/material-compat", params);
}

export function createMaterialCompat(data) {
  return apiPost("/material-compat", data);
}

export function updateMaterialCompat(id, data) {
  return apiPut(`/material-compat/${id}`, data);
}

export function deleteMaterialCompat(id) {
  return apiDelete(`/material-compat/${id}`);
}

// Article Master
export function fetchArticleList(params) {
  return apiGetWithQuery("/articles", params);
}

export function createArticle(data) {
  return apiPost("/articles", data);
}

export function updateArticle(id, data) {
  return apiPut(`/articles/${id}`, data);
}

export function deleteArticle(id) {
  return apiDelete(`/articles/${id}`);
}

// Supplier Mapping
export function fetchMaterialSupplierList(params) {
  return apiGetWithQuery("/material-suppliers", params);
}

export function createMaterialSupplier(data) {
  return apiPost("/material-suppliers", data);
}

export function updateMaterialSupplier(id, data) {
  return apiPut(`/material-suppliers/${id}`, data);
}

export function deleteMaterialSupplier(id) {
  return apiDelete(`/material-suppliers/${id}`);
}

// Imports
export function importSpn(rows) {
  return apiPost("/import/spn", { rows });
}

export function importMaterials(rows) {
  return apiPost("/import/materials", { rows });
}

export function importMaterialCompat(rows) {
  return apiPost("/import/material-compat", { rows });
}

export function importArticles(rows) {
  return apiPost("/import/articles", { rows });
}

export function importMaterialSuppliers(rows) {
  return apiPost("/import/material-suppliers", { rows });
}
