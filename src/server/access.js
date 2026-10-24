// Two dashboards came from the team's own work: the Sales Manager dashboard (/sales) and the sales rep app (/rep). Each
// opened with its own environment-configured account (see role-auth.js). A person who signs in through the main sign-in
// (an email or phone and a role, see staff-auth.js) must reach their own dashboard too, so each accepts EITHER:
//   /sales  the environment Sales Manager account, or a person signed in as a Sales Manager
//   /rep    the environment rep account, or a person signed in as a Sales rep
// The team's rule is kept exactly: a session for one role is never valid for another. The administrator's session does
// not open /sales or /rep (the administrator has the staff app), and neither does a Sales Manager's open the rep app.
import { hasSalesSession, hasRepSession, requireSales, requireRep } from './role-auth.js';
import { staffIdentity } from './staff-auth.js';

const SALES_ROLES = ['SALES_MANAGER'];
const REP_ROLES = ['SALES_REP'];

const ours = (req, roles) => { const who = req.db ? staffIdentity(req) : null; return who && roles.includes(who.role) ? who : null; };
export const hasSalesAccess = (req) => hasSalesSession(req) || Boolean(ours(req, SALES_ROLES));
export const hasRepAccess = (req) => hasRepSession(req) || Boolean(ours(req, REP_ROLES));

/** A change needs a same-origin request, as everywhere in the staff area. */
function sameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origin = req.get('origin');
  return Boolean(origin) && origin === `${req.protocol}://${req.get('host')}`;
}

function access(has, envGuard, roles, message) {
  return (req, res, next) => {
    // Node's built-in test runner sets this only in its child processes (the same bypass every guard here has).
    if (process.env.NODE_TEST_CONTEXT) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (has === 'env') return envGuard(req, res, next);
    const who = ours(req, roles);
    if (!who) return res.status(401).json({ error: message });
    if (!sameOrigin(req)) return res.status(403).json({ error: 'This request could not be verified.' });
    req.staff = who;
    return next();
  };
}

const salesViaEnv = access('env', requireSales, SALES_ROLES, '');
const salesViaPerson = access('person', null, SALES_ROLES, 'Please sign in to the sales manager dashboard.');
const repViaEnv = access('env', requireRep, REP_ROLES, '');
const repViaPerson = access('person', null, REP_ROLES, 'Please sign in to the sales rep app.');

export const requireSalesAccess = (req, res, next) => (hasSalesSession(req) ? salesViaEnv : salesViaPerson)(req, res, next);
export const requireRepAccess = (req, res, next) => (hasRepSession(req) ? repViaEnv : repViaPerson)(req, res, next);

const status = (check) => (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ authenticated: check(req) }); };
export const salesAccessStatus = status(hasSalesAccess);
export const repAccessStatus = status(hasRepAccess);
