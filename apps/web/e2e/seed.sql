-- Test data for the browser tests: one library with an admin, two families and four books.
insert into users (id, name, email, email_verified, updated_at) values
  ('e2e-owner', 'Owen', 'owner@e2e.test', 1, 0),
  ('e2e-admin', 'Alex', 'admin@e2e.test', 1, 0),
  ('e2e-parent', 'Priya', 'parent@e2e.test', 1, 0),
  ('e2e-other', 'Sam', 'other@e2e.test', 1, 0),
  -- Sign-in codes are limited to 3 per address every 10 minutes, so tests that
  -- sign in again get their own people: one for the kiosk, one per browser.
  ('e2e-kiosk-admin', 'Kit', 'kiosk-admin@e2e.test', 1, 0),
  ('e2e-signin-chrome', 'Ana', 'signin-chrome@e2e.test', 1, 0),
  ('e2e-signin-safari', 'Ben', 'signin-safari@e2e.test', 1, 0),
  ('e2e-signin-firefox', 'Cy', 'signin-firefox@e2e.test', 1, 0);
insert into platform_admins (user_id) values ('e2e-owner');
insert into libraries (id, name, slug, settings, terms_accepted_at) values
  ('e2e-lib', 'E2E Owls', 'e2e-owls', '{"closedWeekdays":[],"timezone":"Australia/Sydney"}', 1);
insert into families (id, library_id, name, status) values
  ('e2e-family', 'e2e-lib', 'Lee', 'active'),
  ('e2e-family-2', 'e2e-lib', 'Okafor', 'active');
insert into memberships (id, library_id, user_id, role, family_id) values
  ('e2e-m-admin', 'e2e-lib', 'e2e-admin', 'admin', null),
  ('e2e-m-parent', 'e2e-lib', 'e2e-parent', 'member', 'e2e-family'),
  ('e2e-m-other', 'e2e-lib', 'e2e-other', 'member', 'e2e-family-2'),
  ('e2e-m-kiosk-admin', 'e2e-lib', 'e2e-kiosk-admin', 'admin', null),
  ('e2e-m-signin-chrome', 'e2e-lib', 'e2e-signin-chrome', 'member', 'e2e-family'),
  ('e2e-m-signin-safari', 'e2e-lib', 'e2e-signin-safari', 'member', 'e2e-family'),
  ('e2e-m-signin-firefox', 'e2e-lib', 'e2e-signin-firefox', 'member', 'e2e-family');
insert into titles (id, library_id, title, authors) values
  ('e2e-t1', 'e2e-lib', 'Owl Babies', 'Martin Waddell'),
  ('e2e-t2', 'e2e-lib', 'The Gruffalo', 'Julia Donaldson'),
  ('e2e-t3', 'e2e-lib', 'Where the Wild Things Are', 'Maurice Sendak'),
  ('e2e-t4', 'e2e-lib', 'Possum Magic', 'Mem Fox');
insert into copies (id, library_id, title_id, short_code, label_printed_at) values
  ('e2e-c1', 'e2e-lib', 'e2e-t1', 'BK2A', 1),
  ('e2e-c2', 'e2e-lib', 'e2e-t2', 'BK3A', 1),
  ('e2e-c3', 'e2e-lib', 'e2e-t3', 'BK4A', 1),
  ('e2e-c4', 'e2e-lib', 'e2e-t4', 'BK5A', 1);

-- A second library where staff check returns in, with a loan due tomorrow (in
-- UTC: today or tomorrow in Sydney, either way "due soon"). Its reminder hour
-- is midnight, so reminders go whenever the test runs the hourly job.
insert into users (id, name, email, email_verified, updated_at) values
  ('e2e-wren-admin', 'Willa', 'wren-admin@e2e.test', 1, 0),
  ('e2e-wren-parent', 'Kai', 'kai@e2e.test', 1, 0);
insert into libraries (id, name, slug, settings, terms_accepted_at) values
  ('e2e-wren', 'E2E Wrens', 'e2e-wrens',
   '{"closedWeekdays":[],"timezone":"Australia/Sydney","returnsNeedCheckIn":true,"reminderHour":0}', 1);
insert into families (id, library_id, name, status) values
  ('e2e-wren-family', 'e2e-wren', 'Ryan', 'active');
insert into memberships (id, library_id, user_id, role, family_id) values
  ('e2e-m-wren-admin', 'e2e-wren', 'e2e-wren-admin', 'admin', null),
  ('e2e-m-wren-parent', 'e2e-wren', 'e2e-wren-parent', 'member', 'e2e-wren-family');
insert into titles (id, library_id, title, authors) values
  ('e2e-t5', 'e2e-wren', 'Diary of a Wombat', 'Jackie French');
insert into copies (id, library_id, title_id, short_code, label_printed_at) values
  ('e2e-c5', 'e2e-wren', 'e2e-t5', 'BK6A', 1);
insert into loans (id, library_id, copy_id, family_id, borrowed_by, borrowed_at, due_on) values
  ('e2e-loan-wombat', 'e2e-wren', 'e2e-c5', 'e2e-wren-family', 'e2e-wren-parent',
   (unixepoch() - 12 * 86400) * 1000, date('now', '+1 day'));
