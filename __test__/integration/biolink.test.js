const biolink = require("../../src/biolink");

describe("Test BioLinkModel class", () => {
    test("test reverse with correct predicate", () => {
        const res = biolink.reverse('treats');
        expect(res).toBe("treated_by");
    })

    test("test reverse with correct predicate if it contains underscore", () => {
        const res = biolink.reverse('treated_by');
        expect(res).toBe("treats");
    })

    test("test reverse with predicate having symmetric equal to true", () => {
        const res = biolink.reverse('correlated_with');
        expect(res).toBe("correlated_with");
    })

    test("test predicate with no inverse property and symmetric not equal to true", () => {
        const res = biolink.reverse('has_phenotype');
        expect(res).toBeUndefined();
    })

    test("test predicate not exist in biolink model", () => {
        const res = biolink.reverse('haha');
        expect(res).toBeUndefined();
    })

    test("if input not string, return undefined", () => {
        const res = biolink.reverse(['dd']);
        expect(res).toBeUndefined();
    })

    describe("Test getDescendants function", () => {
        test("if input is in biolink model, return all its desendants and itself", () => {
            const res = biolink.getDescendantClasses('MolecularEntity');
            expect(res).toContain("Drug");
            expect(res).toContain("Gene");
            expect(res).toContain("MolecularEntity");
        })

        test("if input is in biolink model but doesn't have descendants, return itself", () => {
            const res = biolink.getDescendantClasses('Gene');
            expect(res).toEqual(["Gene"])
        })

        test("if input is not in biolink, return itself", () => {
            const res = biolink.getDescendantClasses('Gene1');
            expect(res).toEqual("Gene1")
        })

    })
})