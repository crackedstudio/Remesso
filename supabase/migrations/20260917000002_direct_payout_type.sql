-- V3's Direct rail forwards the funding asset itself, so it is a third payout
-- type rather than a variant of the existing two.
alter type payout_type add value if not exists 'direct';
