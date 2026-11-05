"""Upload size: a model kept at full resolution must come back from the editor."""


def test_an_edited_full_resolution_model_fits_the_upload_limit(client):
    """The editor saves through an STL upload: at the pipeline's 2M-triangle maximum a
    binary STL is 84 + 50 * 2,000,000 bytes (~95 MB). It must reach the mesh reader
    (422 here, it is all zeros), not be turned away for its size (413)."""
    payload = bytes(84 + 50 * 2_000_000)
    r = client.post("/api/process", files={"file": ("modifica.stl", payload, "model/stl")})
    assert r.status_code == 422, r.text
