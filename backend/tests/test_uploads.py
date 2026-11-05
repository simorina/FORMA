"""Upload size: a model kept at full resolution must come back from the editor."""


def test_an_edited_full_resolution_model_fits_the_upload_limit(client):
    """The editor saves through an STL upload: a 2M-triangle model is a binary STL of
    84 + 50 * 2,000,000 bytes (~95 MB, over the old 40 MB limit). It must reach the mesh
    reader (422 here, it is all zeros), not be turned away for its size (413). The largest
    model kept is checked against the limit in test_quality.py."""
    payload = bytes(84 + 50 * 2_000_000)
    r = client.post("/api/process", files={"file": ("modifica.stl", payload, "model/stl")})
    assert r.status_code == 422, r.text
