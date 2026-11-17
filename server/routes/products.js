// Product master & price list, configurator options, documents and categories.
import { Router } from 'express';
import { intId } from '../util.js';
import { allow } from '../auth.js';
import {
  listProducts, productDetail, saveProduct, saveOption, removeOption, addDocument, removeDocument, listCategories, saveCategory,
} from '../services/products.js';
import { h } from './helpers.js';

const r = Router();
const id = (req) => intId(req.params.id);

r.get('/products', allow('products.view'), h((req) => listProducts(req.query)));
r.get('/products/:id', allow('products.view'), h((req) => productDetail(id(req))));
r.post('/products', allow('products.edit'), h((req) => saveProduct(null, req.body || {}, req.user), 201));
r.put('/products/:id', allow('products.edit'), h((req) => saveProduct(id(req), req.body || {}, req.user)));
r.post('/products/:id/options', allow('products.edit'), h((req) => saveOption(id(req), null, req.body || {}), 201));
r.put('/products/:id/options/:optionId', allow('products.edit'), h((req) => saveOption(id(req), intId(req.params.optionId), req.body || {})));
r.delete('/products/:id/options/:optionId', allow('products.edit'), h((req) => removeOption(id(req), intId(req.params.optionId))));
r.post('/products/:id/documents', allow('products.edit'), h((req) => addDocument(id(req), req.body || {}, req.user), 201));
r.delete('/products/:id/documents/:docId', allow('products.edit'), h((req) => removeDocument(id(req), intId(req.params.docId))));
r.get('/product-categories', allow('products.view'), h(() => listCategories()));
r.post('/product-categories', allow('products.edit'), h((req) => saveCategory(null, req.body || {}), 201));
r.put('/product-categories/:id', allow('products.edit'), h((req) => saveCategory(id(req), req.body || {})));

export default r;
