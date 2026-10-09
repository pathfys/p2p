from app.gender import looks_female


def test_female_names():
    for n in ["Анна", "Мария", "Ольга", "Настя", "Юлия", "Екатерина", "Alexandra", "Katie", "Виктория"]:
        assert looks_female(n), n


def test_male_and_unknown():
    for n in ["Никита", "Илья", "Паша", "Иван", "Дмитрий", "John", "Борис", "", None]:
        assert not looks_female(n), n


def test_username_fallback():
    assert looks_female(None, "anna_k")
    assert not looks_female(None, "crypto_king")
