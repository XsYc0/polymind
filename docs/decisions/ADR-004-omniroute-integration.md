# ADR-004: OmniRoute Integration

Status: pending upstream review.

Task 1 defines `integrations/omniroute` as a future optional adapter boundary. PolyMind does not copy OmniRoute code or fabricate API calls. Upstream repository URL, license, and reviewed commit/tag remain pending until live upstream inspection is performed.

Decision direction: selectively adapt public concepts through PolyMind's own provider, registry, and router contracts rather than making OmniRoute an inseparable core dependency.
