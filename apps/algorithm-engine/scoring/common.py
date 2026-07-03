def validate_normalized(**values: float) -> None:
    for name, value in values.items():
        if not 0 <= value <= 1:
            raise ValueError(f"{name} must be between 0 and 1")
