-- Anonymous request ownership.
--
-- A request can be posted without an account, which is the point: someone with a
-- dead laptop should not have to register before asking for help. But an
-- anonymous row with no way to prove ownership is also a row anybody can cancel.
--
-- So creation issues an opaque token, only its HMAC is stored, and cancelling a
-- request requires either that token or a signed-in requester. The token is not a
-- session: it grants nothing except changing this one request's status, which is
-- why it does not expire and why it is safe to hand out in the creation response.
--
-- NULL for signed-in requesters, who authenticate instead. The partial unique
-- index keeps lookups cheap without forcing every authenticated row to carry a
-- dummy value.
ALTER TABLE request ADD COLUMN access_token_hash TEXT;

CREATE UNIQUE INDEX idx_request_access_token
  ON request(access_token_hash)
  WHERE access_token_hash IS NOT NULL;
