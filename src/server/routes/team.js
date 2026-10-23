// Staff accounts: who can sign in to the staff area and as what. Mounted behind requireStaff and
// requireRole(ADMIN, SALES_MANAGER): the administrator manages every kind of account, a Sales Manager
// manages sales reps only (enforced in domain/staff-accounts.js, not just here).
//
// A new account comes back with a one-time password, shown once; only its hash is kept, and the
// person must choose their own the first time they sign in.
import express from 'express';
import {
  listStaffUsers, createStaffUser, resetStaffPassword, setStaffActive, rolesManagedBy, StaffAccountError, ROLE_LABEL,
} from '../../domain/staff-accounts.js';
import { listReps } from '../../domain/shelf.js';
import { todayString } from '../../domain/expiry-list.js';

const router = express.Router();
const fail = (e, res, next) => (e instanceof StaffAccountError ? res.status(e.status).json({ error: e.message, code: e.code }) : next(e));

router.get('/', (req, res, next) => {
  try {
    const roles = rolesManagedBy(req.staff.role);
    res.json({
      users: listStaffUsers(req.db, req.staff.role),
      roles: roles.map((r) => ({ role: r, label: ROLE_LABEL[r] })),
      // a sales rep account is linked to one of these (a sample list until the Odoo salespeople are synced)
      reps: listReps(todayString(), req.db).map((r) => ({ id: r.id, name: r.name, sample: r.sample === true })),
    });
  } catch (e) { next(e); }
});

router.post('/', (req, res, next) => {
  try { res.status(201).json(createStaffUser(req.db, req.body || {}, req.staff.role, req.staff.name)); } catch (e) { fail(e, res, next); }
});

router.post('/:id/reset-password', (req, res, next) => {
  try { res.json(resetStaffPassword(req.db, req.params.id, req.staff.role)); } catch (e) { fail(e, res, next); }
});

router.post('/:id/active', (req, res, next) => {
  try { res.json({ user: setStaffActive(req.db, req.params.id, req.body?.active === true, req.staff.role) }); } catch (e) { fail(e, res, next); }
});

export default router;
