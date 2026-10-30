// Customer-submitted returns, separate from the Odoo read-copy returns routes.
import express from 'express';
import {
  createCustomerReturnRequest, decideCustomerReturnRequest, listCustomerReturnRequests,
  listReturnableItems, listStaffCustomerReturnRequests, CustomerReturnRequestError,
} from '../../domain/customer-return-requests.js';
import { requireCustomer } from '../customer-access.js';

export const customerReturnRequestsRouter = express.Router();
export const staffCustomerReturnRequestsRouter = express.Router();

const fail = (error, res, next) => (
  error instanceof CustomerReturnRequestError
    ? res.status(error.status).json({ error: error.message })
    : next(error)
);

customerReturnRequestsRouter.get('/', requireCustomer, (req, res, next) => {
  try {
    res.json({
      items: listReturnableItems(req.db, req.customer.id),
      requests: listCustomerReturnRequests(req.db, req.customer.id),
    });
  } catch (error) { next(error); }
});

customerReturnRequestsRouter.post('/', requireCustomer, (req, res, next) => {
  try {
    const request = createCustomerReturnRequest(req.db, req.customer.id, req.body || {});
    res.status(201).json({ request });
  } catch (error) { fail(error, res, next); }
});

staffCustomerReturnRequestsRouter.get('/', (req, res, next) => {
  try { res.json({ requests: listStaffCustomerReturnRequests(req.db) }); } catch (error) { next(error); }
});

staffCustomerReturnRequestsRouter.post('/:reference/decision', (req, res, next) => {
  try {
    const decision = decideCustomerReturnRequest(
      req.db, req.params.reference, req.body || {}, req.staff?.name,
    );
    res.json({ decision });
  } catch (error) { fail(error, res, next); }
});
