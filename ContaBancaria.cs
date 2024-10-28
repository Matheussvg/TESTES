using System;
using System.Globalization;

namespace Questao1
{
    class ContaBancaria
    {
        private int Numero {get; set;}
        public string Titular {get; set;}
        private double Saldo {get; set;}

        public double TaxaSaque = 3.50;

        

        public ContaBancaria(int numero, string titular)
        {
            this.Numero = numero;
            this.Titular = titular;
            
        }


        public ContaBancaria(int numero, string titular, double depositoInicial)
        {
            this.Numero = numero;
            this.Titular = titular;
            this.Saldo = depositoInicial;
        }
        

        public void Deposito(double quantia)
        {
           Saldo += quantia;
        }

        public void Saque(double quantia)
        {
            Saldo -= quantia + TaxaSaque;
        }

        public override string ToString()
        {
            return $"Conta {Numero}, Titular: {Titular}, Saldo: $ {Saldo}";
        }

    }
}
