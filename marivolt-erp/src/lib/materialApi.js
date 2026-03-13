import { apiGet, apiGetWithQuery, apiPost, apiPut, apiDelete } from "./api.js";

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

// Resolve Material
export function resolveMaterial(payload) {
  return apiPost("/resolve-material", payload);
}

